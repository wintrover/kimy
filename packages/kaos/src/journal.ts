import type { Environment } from './environment';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

// ── Public types ──────────────────────────────────────────────────

export interface FileChange {
  readonly path: string;
  readonly action: 'created' | 'modified' | 'deleted';
  readonly timestamp: number;
}

export interface TransactionSnapshot {
  readonly baseCommitHash: string;
  readonly createdAt: number;
}

// ── JournalKaos ───────────────────────────────────────────────────

/**
 * A decorator that wraps any {@link Kaos} instance and records all write
 * operations while passing reads through unchanged.
 */
export class JournalKaos implements Kaos {
  private readonly _inner: Kaos;
  private readonly _changes: FileChange[] = [];
  private _snapshot: TransactionSnapshot | null = null;

  constructor(inner: Kaos) {
    this._inner = inner;
  }

  // ── Read-only pass-through ───────────────────────────────────────

  get name(): string {
    return this._inner.name;
  }

  get osEnv(): Environment {
    return this._inner.osEnv;
  }

  pathClass(): 'posix' | 'win32' {
    return this._inner.pathClass();
  }

  normpath(path: string): string {
    return this._inner.normpath(path);
  }

  gethome(): string {
    return this._inner.gethome();
  }

  getcwd(): string {
    return this._inner.getcwd();
  }

  chdir(path: string): Promise<void> {
    return this._inner.chdir(path);
  }

  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    return this._inner.stat(path, options);
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    yield* this._inner.iterdir(path);
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    yield* this._inner.glob(path, pattern, options);
  }

  readBytes(path: string, n?: number): Promise<Buffer> {
    return this._inner.readBytes(path, n);
  }

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    return this._inner.readText(path, options);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    yield* this._inner.readLines(path, options);
  }

  // ── Write operations (recorded + delegated) ──────────────────────

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const existed = await this._pathExists(path);
    const result = await this._inner.writeText(path, data, options);
    this._recordChange(path, existed ? 'modified' : 'created');
    return result;
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    const existed = await this._pathExists(path);
    const result = await this._inner.writeBytes(path, data);
    this._recordChange(path, existed ? 'modified' : 'created');
    return result;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const existed = await this._pathExists(path);
    await this._inner.mkdir(path, options);
    if (!existed) {
      this._recordChange(path, 'created');
    }
  }

  // ── Process execution ────────────────────────────────────────────

  exec(...args: string[]): Promise<KaosProcess> {
    return this._inner.exec(...args);
  }

  execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    return this._inner.execWithEnv(args, env);
  }

  // ── Decorator factory methods ────────────────────────────────────

  withCwd(cwd: string): JournalKaos {
    return new JournalKaos(this._inner.withCwd(cwd));
  }

  withEnv(env: Record<string, string>): JournalKaos {
    return new JournalKaos(this._inner.withEnv(env));
  }

  // ── Journal API ──────────────────────────────────────────────────

  /** Return a readonly list of all recorded file changes. */
  getChangedFiles(): readonly FileChange[] {
    return this._changes;
  }

  /** Clear the journal and snapshot. */
  clearJournal(): void {
    this._changes.length = 0;
    this._snapshot = null;
  }

  /**
   * Capture a git snapshot by recording the current HEAD commit hash.
   * Delegates to `inner.exec('git', 'rev-parse', 'HEAD')`.
   */
  async captureSnapshot(): Promise<TransactionSnapshot> {
    const proc = await this._inner.exec('git', 'rev-parse', 'HEAD');
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await proc.wait();
    const hash = Buffer.concat(chunks).toString('utf-8').trim();
    const snapshot: TransactionSnapshot = {
      baseCommitHash: hash,
      createdAt: Date.now(),
    };
    this._snapshot = snapshot;
    return snapshot;
  }

  /** Return the previously captured snapshot, or `null`. */
  getSnapshot(): TransactionSnapshot | null {
    return this._snapshot;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private _recordChange(path: string, action: 'created' | 'modified' | 'deleted'): void {
    this._changes.push({ path, action, timestamp: Date.now() });
  }

  private async _pathExists(path: string): Promise<boolean> {
    try {
      await this._inner.stat(path, { followSymlinks: false });
      return true;
    } catch {
      return false;
    }
  }
}
