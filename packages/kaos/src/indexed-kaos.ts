/**
 * IndexedKaos — a {@link Kaos} implementation that reads **only** from
 * a {@link MerkleFileIndex}, never falling back to the real filesystem.
 *
 * This enforces Single Source of Truth: if a path is not in the index,
 * every read operation throws {@link IndexMissError}.  Write operations
 * mutate the in-memory index directly; process execution is blocked.
 *
 * Path operations (`normpath`, `gethome`, `getcwd`, etc.) are delegated
 * to an underlying `Kaos` instance (typically `LocalKaos`) so that path
 * semantics match the host OS without touching the filesystem for reads.
 */
import * as nodePath from 'node:path';

import type { Kaos } from './kaos';
import type { Environment } from './environment';
import type { KaosProcess } from './process';
import type { ContentVector, SnapshotOptions, StatResult } from './types';
import type { MutationRecorder } from './mutation-log-types';
import { MerkleFileIndex } from './merkle-file-index';
import { KaosError } from './errors';

// ── Public error ──────────────────────────────────────────────────

/**
 * Thrown when a path is not found in the index.
 *
 * IndexedKaos **never** falls back to the real filesystem.  This error
 * is the signal that a file must be added to the index before it can be
 * read.
 */
export class IndexMissError extends KaosError {
  /** The normalized path that was looked up. */
  public readonly path: string;

  constructor(path: string) {
    super(`Index miss: path not found in MerkleFileIndex: ${path}`);
    this.name = 'IndexMissError';
    this.path = path;
  }
}

// ── IndexedKaos ───────────────────────────────────────────────────

/**
 * A {@link Kaos} implementation backed entirely by a
 * {@link MerkleFileIndex}.
 *
 * Reads are served from the index; writes mutate it.  Path resolution,
 * environment detection, and `cwd` management are delegated to an
 * underlying `Kaos` (the "delegate") so that platform-specific path
 * semantics are preserved without touching the real filesystem.
 *
 * @example
 * ```ts
 * const local = await LocalKaos.create();
 * const index = new MerkleFileIndex();
 * index.writeFile('/src/hello.ts', 'console.log("hi")');
 * const kaos = new IndexedKaos(local, index);
 * const text = await kaos.readText('/src/hello.ts'); // "console.log("hi")"
 * ```
 */
export class IndexedKaos implements Kaos {
  readonly name: string = 'indexed';
  readonly osEnv: Environment;

  private readonly _delegate: Kaos;
  private readonly _index: MerkleFileIndex;
  private _mutationLog: MutationRecorder | undefined;
  private _nextSequenceId: (() => number) | undefined;
  private _agentId = 'main';

  /**
   * @param delegate - Underlying Kaos used for path ops and env
   *   detection.  Never consulted for file I/O.
   * @param index - The MerkleFileIndex that serves as the single source
   *   of truth for all file reads.
   * @param mutationLog - Optional recorder for tracking file mutations.
   * @param nextSequenceId - Optional factory for deterministic sequence ids.
   */
  constructor(
    delegate: Kaos,
    index: MerkleFileIndex,
    mutationLog?: MutationRecorder,
    nextSequenceId?: () => number,
  ) {
    this._delegate = delegate;
    this._index = index;
    this.osEnv = delegate.osEnv;
    this._mutationLog = mutationLog;
    this._nextSequenceId = nextSequenceId;
  }

  // ── Path operations (delegated) ─────────────────────────────────

  /** Return the path style of the underlying environment. */
  pathClass(): 'posix' | 'win32' {
    return this._delegate.pathClass();
  }

  /** Normalize `path` using the delegate's platform rules. */
  normpath(path: string): string {
    return this._delegate.normpath(path);
  }

  /** Return the home directory of the underlying environment. */
  gethome(): string {
    return this._delegate.gethome();
  }

  /** Return the current working directory from the delegate. */
  getcwd(): string {
    return this._delegate.getcwd();
  }

  /** Change the delegate's working directory (does not touch the index). */
  async chdir(path: string): Promise<void> {
    await this._delegate.chdir(path);
  }

  /**
   * Return a new {@link IndexedKaos} with the delegate's cwd changed
   * to `cwd`.  The index is shared.
   */
  withCwd(cwd: string): IndexedKaos {
    const child = new IndexedKaos(
      this._delegate.withCwd(cwd),
      this._index,
      this._mutationLog,
      this._nextSequenceId,
    );
    child._agentId = this._agentId;
    return child;
  }

  /**
   * Return a new {@link IndexedKaos} with the delegate's env overlaid.
   * The index and mutation log are shared.
   */
  withEnv(env: Record<string, string>): IndexedKaos {
    const child = new IndexedKaos(
      this._delegate.withEnv(env),
      this._index,
      this._mutationLog,
      this._nextSequenceId,
    );
    child._agentId = this._agentId;
    return child;
  }

  // ── File reads (index only) ─────────────────────────────────────

  /**
   * Read the file at `path` as a string.
   *
   * @throws {IndexMissError} if the path is not present in the index.
   */
  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const content = this._index.getFileContent(this.normpath(path));
    if (content === undefined) throw new IndexMissError(path);
    return content;
  }

  /**
   * Read up to `n` bytes from the file at `path`.
   *
   * The index stores text; bytes are obtained by encoding the stored
   * string as UTF-8.
   *
   * @throws {IndexMissError} if the path is not present in the index.
   */
  async readBytes(path: string, n?: number): Promise<Buffer> {
    const text = await this.readText(path);
    const buf = Buffer.from(text, 'utf-8');
    return n !== undefined ? buf.subarray(0, n) : buf;
  }

  /**
   * Yield lines from the file at `path` one by one.
   *
   * Lines are split on `\n` (LF).  The trailing newline is **not**
   * included in the yielded string, matching `readFileSync` + `.split('\n')`
   * semantics.
   *
   * @throws {IndexMissError} if the path is not present in the index.
   */
  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    for (const line of text.split('\n')) {
      yield line;
    }
  }

  /**
   * Return stat metadata for the file at `path`.
   *
   * Only `stSize` and `stMtime` carry meaningful data from the index;
   * the remaining fields are zeroed out.
   *
   * @throws {IndexMissError} if the path is not present in the index.
   */
  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const entry = this._index.getEntry(this.normpath(path));
    if (entry === undefined) throw new IndexMissError(path);
    return {
      stMode: 0o100644,
      stIno: 0,
      stDev: 0,
      stNlink: 1,
      stUid: 0,
      stGid: 0,
      stSize: entry.size,
      stAtime: entry.mtime,
      stMtime: entry.mtime,
      stCtime: entry.mtime,
    };
  }

  /**
   * Yield the full paths of direct children of the directory at `path`.
   *
   * @throws {IndexMissError} if `path` is not a known directory.
   */
  async *iterdir(path: string): AsyncGenerator<string> {
    const children = this._index.listDir(this.normpath(path));
    if (children === undefined) throw new IndexMissError(path);
    for (const child of children) {
      yield child;
    }
  }

  /**
   * Yield paths matching `pattern` under `path`.
   *
   * Delegates to {@link MerkleFileIndex.glob} which supports `*`
   * (single segment) and `**` (recursive) wildcards.
   */
  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const normalizedPath = this.normpath(path);
    const rootDir = this._index.rootDir;

    // Make the search path relative to the index root.
    const relativeDir = nodePath.posix.relative(rootDir, normalizedPath);

    // Combine: if relativeDir is '' use pattern as-is, otherwise prefix it.
    const fullPattern = relativeDir === '' ? pattern : `${relativeDir}/${pattern}`;

    for await (const rel of this._index.glob(fullPattern)) {
      yield rel;
    }
  }

  // ── File writes (index mutation) ────────────────────────────────

  /**
   * Write `data` to the file at `path` in the index.
   *
   * @returns The number of characters written.
   */
  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const normalized = this.normpath(path);
    const mode = options?.mode ?? 'w';
    let content = data;
    if (mode === 'a') {
      const existing = this._index.getFileContent(normalized);
      content = (existing ?? '') + data;
    }
    this._index.writeFile(normalized, Buffer.from(content, 'utf-8'));

    if (this._mutationLog && this._nextSequenceId) {
      this._mutationLog.record({
        type: 'write',
        path: normalized,
        content,
        staticSequenceId: this._nextSequenceId(),
        agentId: this._agentId,
      });
    }

    return data.length;
  }

  /**
   * Write raw bytes to `path` in the index.
   *
   * The buffer is encoded as UTF-8 before storage.
   *
   * @returns The number of bytes written.
   */
  async writeBytes(path: string, data: Buffer): Promise<number> {
    const normalized = this.normpath(path);
    this._index.writeFile(normalized, data);

    if (this._mutationLog && this._nextSequenceId) {
      this._mutationLog.record({
        type: 'write',
        path: normalized,
        content: data.toString('utf-8'),
        staticSequenceId: this._nextSequenceId(),
        agentId: this._agentId,
      });
    }

    return data.length;
  }

  /**
   * Delete a file from the index and record the mutation.
   *
   * @returns `true` if the file existed and was removed.
   */
  async deleteFile(path: string): Promise<boolean> {
    const normalized = this.normpath(path);
    const removed = this._index.deleteFile(normalized);

    if (this._mutationLog && this._nextSequenceId) {
      this._mutationLog.record({
        type: 'delete',
        path: normalized,
        staticSequenceId: this._nextSequenceId(),
        agentId: this._agentId,
      });
    }

    return removed;
  }

  /**
   * Configure mutation logging after construction.
   */
  setMutationLog(log: MutationRecorder, nextSequenceId: () => number): void {
    this._mutationLog = log;
    this._nextSequenceId = nextSequenceId;
  }

  /**
   * Set the agent identifier used in mutation records.
   */
  setAgentId(id: string): void {
    this._agentId = id;
  }

  /**
   * Ensure a directory node exists in the index.
   *
   * When `parents` is true (the default), all ancestor directories are
   * created as well.
   */
  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    this._index.ensureDir(this.normpath(path), { parents: options?.parents ?? true });
  }

  async snapshot(_root: string, _options?: SnapshotOptions): Promise<ContentVector> {
    throw new Error('IndexedKaos.snapshot() is not yet implemented');
  }

  // ── Process execution (blocked) ─────────────────────────────────

  /**
   * Spawn a process — always throws.
   *
   * IndexedKaos is designed for hermetic, index-backed reads and
   * in-memory writes.  Use a `LocalKaos` or `SandboxKaos` for
   * process execution.
   */
  async exec(...args: string[]): Promise<KaosProcess> {
    throw new KaosError(
      'exec() blocked in IndexedKaos — use LocalKaos or SandboxKaos for process execution',
    );
  }

  /**
   * Spawn a process with explicit env — always throws.
   *
   * @see {@link IndexedKaos.exec}
   */
  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    throw new KaosError(
      'execWithEnv() blocked in IndexedKaos — use LocalKaos or SandboxKaos for process execution',
    );
  }

  // ── Index access ────────────────────────────────────────────────

  /**
   * Return the underlying {@link MerkleFileIndex}.
   *
   * Intended for merge / commit workflows that need direct access to
   * the index state (e.g. computing a root hash or serializing to a
   * snapshot format).
   */
  getIndex(): MerkleFileIndex {
    return this._index;
  }
}
