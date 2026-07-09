/**
 * HermeticKaos — a {@link Kaos} implementation that gives subagents a
 * frozen {@link MerkleSnapshot}.  Changes are Copy-on-Write (the index
 * is mutated in place but a new snapshot is taken after every write).
 * Process execution is completely blocked.
 *
 * Path operations are delegated to an underlying `Kaos` so platform
 * semantics are preserved.  All file reads are served from the
 * {@link MerkleFileIndex}; writes mutate the index and refresh the
 * snapshot.
 */
import type { Kaos } from './kaos';
import type { Environment } from './environment';
import type { KaosProcess } from './process';
import type { ContentVector, SnapshotOptions, StatResult } from './types';
import type { MutationRecorder } from './mutation-log-types';
import { MerkleFileIndex } from './merkle-file-index';
import type { MerkleSnapshot } from './merkle-file-index';
import { KaosSandboxError } from './errors';
import { SnapshotProjector, buildSandboxEnv } from './snapshot-projector';
import { VFSPathFactory } from './path';
import type { CanonicalVFSPath } from './path';

// Simple async mutex for serializing exec calls within a single HermeticKaos instance.
class _Mutex {
  private _locked = false;
  private readonly _waitQueue: Array<() => void> = [];

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this._acquire();
    try { return await fn(); }
    finally { this._release(); }
  }

  private async _acquire(): Promise<void> {
    if (!this._locked) { this._locked = true; return; }
    return new Promise<void>((resolve) => { this._waitQueue.push(resolve); });
  }

  private _release(): void {
    const next = this._waitQueue.shift();
    if (next !== undefined) next();
    else this._locked = false;
  }
}

// ── HermeticKaos ───────────────────────────────────────────────────

/**
 * A sandboxed {@link Kaos} backed by a {@link MerkleFileIndex}.
 *
 * Reads are served from the index; writes mutate it in place and refresh
 * the frozen snapshot (Copy-on-Write semantics at the snapshot level).
 * Path resolution, environment detection, and `cwd` management are
 * delegated to an underlying `Kaos` (the "delegate") so that
 * platform-specific path semantics are preserved without touching the
 * real filesystem.
 *
 * Process execution (`exec`, `execWithEnv`) is blocked by default and
 * throws {@link KaosSandboxError}.  When `allowProjection` is enabled,
 * exec calls project the index into a shadow directory and
 * reverse-project changes after execution.
 *
 * @example
 * ```ts
 * const local = await LocalKaos.create();
 * const index = await MerkleFileIndex.buildFrom(local);
 * const hermetic = new HermeticKaos(local, index);
 * const snapshot = hermetic.getSnapshot();
 * // snapshot is frozen at construction time
 * ```
 */
export class HermeticKaos implements Kaos {
  readonly name: string = 'hermetic';
  readonly osEnv: Environment;

  private readonly _delegate: Kaos;
  private readonly _index: MerkleFileIndex;
  private _snapshot: MerkleSnapshot;
  private _mutationLog: MutationRecorder | undefined;
  private _nextSequenceId: (() => number) | undefined;
  private _agentId: string = 'hermetic';

  private readonly _allowProjection: boolean;
  private _execMutex: _Mutex | undefined;
  private readonly _factory: VFSPathFactory;

  /**
   * @param delegate - Underlying Kaos used for path ops and env
   *   detection.  Never consulted for file I/O.
   * @param index - The MerkleFileIndex that serves as the single source
   *   of truth for all file reads and writes.
   */

  constructor(delegate: Kaos, index: MerkleFileIndex, options?: { allowProjection?: boolean }) {
    this._delegate = delegate;
    this._index = index;
    this.osEnv = delegate.osEnv;
    this._snapshot = index.branch();
    this._allowProjection = options?.allowProjection ?? false;
    this._factory = new VFSPathFactory(index.rootDir);
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

  /** No-op in hermetic mode — the cwd is frozen at construction. */
  async chdir(_path: string): Promise<void> {
    // Intentional no-op.
  }

  /**
   * Return a new {@link HermeticKaos} with the delegate's cwd changed
   * to `cwd`.  The index is shared.
   */
  withCwd(cwd: string): HermeticKaos {
    const child = new HermeticKaos(this._delegate.withCwd(cwd), this._index, { allowProjection: this._allowProjection });
    if (this._mutationLog) {
      child.setMutationLog(this._mutationLog, this._nextSequenceId!);
    }
    child.setAgentId(this._agentId);
    return child;
  }

  /**
   * Return a new {@link HermeticKaos} with the delegate's env overlaid.
   * The index is shared.
   */
  withEnv(env: Record<string, string>): HermeticKaos {
    const child = new HermeticKaos(this._delegate.withEnv(env), this._index, { allowProjection: this._allowProjection });
    if (this._mutationLog) {
      child.setMutationLog(this._mutationLog, this._nextSequenceId!);
    }
    child.setAgentId(this._agentId);
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
    const content = this._index.getFileContent(this._factory.create(this.normpath(path)));
    if (content === undefined) {
      throw new KaosSandboxError(`File not found in hermetic index: ${path}`);
    }
    return content;
  }

  /**
   * Read up to `n` bytes from the file at `path`.
   *
   * The index stores text; bytes are obtained by encoding the stored
   * string as UTF-8.
   *
   * @throws {KaosSandboxError} if the path is not present in the index.
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
   * included in the yielded string.
   *
   * @throws {KaosSandboxError} if the path is not present in the index.
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
   * @throws {KaosSandboxError} if the path is not present in the index.
   */
  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const entry = this._index.getEntry(this._factory.create(this.normpath(path)));
    if (entry === undefined) {
      throw new KaosSandboxError(`File not found in hermetic index: ${path}`);
    }
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
   * @throws {KaosSandboxError} if `path` is not a known directory.
   */
  async *iterdir(path: string): AsyncGenerator<string> {
    const children = this._index.listDir(this._factory.create(this.normpath(path)));
    if (children === undefined) {
      throw new KaosSandboxError(`Directory not found in hermetic index: ${path}`);
    }
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
    const relativeDir = this._factory.create(this.normpath(path));
    const fullPattern = relativeDir === '' ? pattern : `${relativeDir}/${pattern}`;
    for await (const rel of this._index.glob(fullPattern)) {
      yield rel;
    }
  }

  // ── File writes (CoW: mutate index, refresh snapshot) ───────────

  /**
   * Write `data` to the file at `path` in the index, then refresh the
   * snapshot (Copy-on-Write).
   *
   * @returns The number of characters written.
   */
  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const normalized = this._factory.create(this.normpath(path));
    const mode = options?.mode ?? 'w';
    let content = data;
    if (mode === 'a') {
      const existing = this._index.getFileContent(normalized);
      content = (existing ?? '') + data;
    }
    this._index.writeFile(normalized, Buffer.from(content, 'utf-8'));
    this._mutationLog?.record({
      type: 'write',
      path: normalized,
      content,
      staticSequenceId: this._nextSequenceId?.() ?? 0,
      agentId: this._agentId,
    });
    this._snapshot = this._index.branch();
    return data.length;
  }

  /**
   * Write raw bytes to `path` in the index, then refresh the snapshot.
   *
   * @returns The number of bytes written.
   */
  async writeBytes(path: string, data: Buffer): Promise<number> {
    const normalized = this._factory.create(this.normpath(path));
    this._index.writeFile(normalized, data);
    this._mutationLog?.record({
      type: 'write',
      path: normalized,
      content: data.toString('utf-8'),
      staticSequenceId: this._nextSequenceId?.() ?? 0,
      agentId: this._agentId,
    });
    this._snapshot = this._index.branch();
    return data.length;
  }

  /**
   * Ensure a directory node exists in the index, then refresh the
   * snapshot.
   */
  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    this._index.ensureDir(this._factory.create(this.normpath(path)), { parents: options?.parents ?? true });
    this._snapshot = this._index.branch();
  }

  async snapshot(_root: string, _options?: SnapshotOptions): Promise<ContentVector> {
    throw new Error('HermeticKaos.snapshot() is not yet implemented');
  }

  // ── Process execution (completely blocked) ──────────────────────

  /**
   * Spawn a process.
   *
   * When `allowProjection` is enabled, executes in a shadow directory
   * projected from the Merkle index.  Otherwise throws {@link KaosSandboxError}.
   */
  async exec(...args: string[]): Promise<KaosProcess> {
    return this.execWithEnv(args);
  }

  /**
   * Spawn a process with explicit env.
   *
   * When `allowProjection` is enabled, projects the index into a shadow
   * directory, executes there with a sandboxed environment, then
   * reverse-projects changes back.  Otherwise throws {@link KaosSandboxError}.
   */
  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    if (!this._allowProjection) {
      throw new KaosSandboxError(
        'execWithEnv() blocked in HermeticKaos — process execution is forbidden in sandboxed mode',
      );
    }

    // Serialize concurrent exec calls within this instance
    if (!this._execMutex) this._execMutex = new _Mutex();

    return this._execMutex.runExclusive(async () => {
      const projector = new SnapshotProjector(this._index, this._delegate);
      const shadowDir = await projector.project();

      try {
        const preExecSnapshot = this._snapshot;
        const sandboxEnv = buildSandboxEnv(env);
        const scopedDelegate = this._delegate.withCwd(shadowDir);
        const process = await scopedDelegate.execWithEnv(args, sandboxEnv);
        await process.wait();

        const changes = await projector.reverseProjection(preExecSnapshot);

        for (const change of changes) {
          this._mutationLog?.record({
            type: change.type === 'deleted' ? 'delete' : 'write',
            path: change.path,
            content: change.type !== 'deleted'
              ? this._index.getFileContent(change.path as CanonicalVFSPath)
              : undefined,
            staticSequenceId: this._nextSequenceId?.() ?? 0,
            agentId: this._agentId,
          });
        }

        this._snapshot = this._index.branch();
        return process;
      } finally {
        await projector.dispose();
      }
    });
  }

  // ── Snapshot & index access ─────────────────────────────────────

  /**
   * Return the current frozen snapshot.
   *
   * The snapshot is refreshed after every write operation (CoW
   * semantics).  Between writes it represents a stable, immutable view
   * of the index at the last mutation point.
   */
  getSnapshot(): MerkleSnapshot {
    return this._snapshot;
  }

  /**
   * Return the underlying {@link MerkleFileIndex}.
   *
   * Intended for merge / commit workflows that need direct access to
   * the index state.
   */
  getIndex(): MerkleFileIndex {
    return this._index;
  }

  /**
   * Inject a mutation recorder for tracking write operations.
   */
  setMutationLog(log: MutationRecorder, nextSequenceId: () => number): void {
    this._mutationLog = log;
    this._nextSequenceId = nextSequenceId;
  }

  /**
   * Set the agent identifier recorded in each mutation.
   */
  setAgentId(id: string): void {
    this._agentId = id;
  }
}


