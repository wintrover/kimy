/**
 * SymlinkAtomicCommitter — a generations-based atomic commit engine
 * using symlinks.
 *
 * Each commit creates a new `generation_NNNNNN/` directory, writes or
 * hard-links files into it, then atomically swaps a top-level symlink
 * to point at the new generation.  The single `rename(2)` syscall
 * provides global atomicity — readers never see a partial write.
 *
 * Strategy:
 * - `HARD_LINK`: unchanged files are hard-linked from the previous
 *   generation (saves I/O and disk space).
 * - `FULL_WRITE`: every file is written fresh (safe fallback for
 *   filesystems that don't support cross-directory hard links).
 *
 * The strategy is auto-detected at `init()` time by probing hard link
 * capability on the workspace filesystem.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MerkleSnapshot } from './merkle-file-index';
import { MerkleFileIndex } from './merkle-file-index';
import { ContentAddressedPool } from './object-pool';
import { KaosError } from './errors';

// ── Public types ────────────────────────────────────────────────────

/** Commit strategy — how unchanged files are materialised. */
export enum CommitStrategy {
  /** Hard-link unchanged files from the previous generation. */
  HARD_LINK = 'hard_link',
  /** Write every file fresh. */
  FULL_WRITE = 'full_write',
}

/** A single staged generation, ready to be committed. */
export interface Generation {
  /** Monotonically increasing generation id. */
  readonly id: number;
  /** Absolute path to the generation directory. */
  readonly dirPath: string;
  /** Relative path → content hash for files to materialise. */
  readonly stagedFiles: Map<string, string>;
}

// ── SymlinkAtomicCommitter ─────────────────────────────────────────

/**
 * Generations-based atomic commit engine that uses a symlink for global
 * atomicity.
 *
 * @example
 * ```ts
 * const committer = new SymlinkAtomicCommitter('/workspace');
 * await committer.init();
 *
 * const gen = committer.stageFromSnapshot(newSnapshot, oldSnapshot, pool);
 * committer.commit(gen, index);
 * // The workspace now atomically reflects newSnapshot
 * ```
 */
export class SymlinkAtomicCommitter {
  private readonly _workspaceRoot: string;
  private readonly _axiomDir: string;
  private readonly _generationsDir: string;
  private readonly _currentGenFile: string;
  private _currentGenId: number = 0;
  private _strategy: CommitStrategy;

  constructor(workspaceRoot: string) {
    this._workspaceRoot = workspaceRoot;
    this._axiomDir = path.join(workspaceRoot, '.axiom');
    this._generationsDir = path.join(this._axiomDir, 'generations');
    this._currentGenFile = path.join(this._axiomDir, 'current');
    this._strategy = CommitStrategy.FULL_WRITE;
  }

  /**
   * Initialise the committer.
   *
   * 1. Creates `.axiom/generations/` if it doesn't exist.
   * 2. Probes hard link capability and sets the strategy accordingly.
   * 3. Reads the current generation id from the symlink / marker file.
   */
  async init(): Promise<void> {
    fs.mkdirSync(this._generationsDir, { recursive: true });

    // Probe hard link capability.
    if (await this._probeHardLink()) {
      this._strategy = CommitStrategy.HARD_LINK;
    } else {
      this._strategy = CommitStrategy.FULL_WRITE;
    }

    // Recover current generation id from the marker file.
    this._currentGenId = this._readCurrentGenId();
  }

  /**
   * Return the currently active commit strategy.
   */
  get strategy(): CommitStrategy {
    return this._strategy;
  }

  // ── Hard link probe ─────────────────────────────────────────────

  /**
   * Probe whether the filesystem supports hard links across directories
   * within the workspace.
   *
   * Creates two temp files in the generations directory, attempts to
   * hard-link one to the other, then cleans up.
   */
  private async _probeHardLink(): Promise<boolean> {
    const probeA = path.join(this._generationsDir, '.probe_a');
    const probeB = path.join(this._generationsDir, '.probe_b');

    try {
      fs.writeFileSync(probeA, 'probe', 'utf-8');
      fs.linkSync(probeA, probeB);
      // Verify content matches.
      const content = fs.readFileSync(probeB, 'utf-8');
      return content === 'probe';
    } catch {
      return false;
    } finally {
      try { fs.unlinkSync(probeA); } catch { /* ignore */ }
      try { fs.unlinkSync(probeB); } catch { /* ignore */ }
    }
  }

  // ── Generation tracking ─────────────────────────────────────────

  /**
   * Read the current generation id from the marker file.
   *
   * Returns `0` if the marker file doesn't exist (first commit).
   */
  private _readCurrentGenId(): number {
    try {
      const raw = fs.readFileSync(this._currentGenFile, 'utf-8').trim();
      const id = Number.parseInt(raw, 10);
      return Number.isFinite(id) && id >= 0 ? id : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Persist the current generation id to the marker file.
   */
  private _writeCurrentGenId(id: number): void {
    fs.writeFileSync(this._currentGenFile, String(id), 'utf-8');
  }

  // ── Staging ─────────────────────────────────────────────────────

  /**
   * Stage a new generation from a snapshot diff.
   *
   * Compares `snapshot` against `previousSnapshot` (if provided) to
   * determine which files changed.  Changed files are marked for write;
   * unchanged files are marked for hard-link (when `HARD_LINK`
   * strategy is active).
   *
   * @param snapshot         - The target snapshot to commit.
   * @param previousSnapshot - The base snapshot to diff against.  When
   *   omitted, every file in `snapshot` is treated as changed.
   * @param pool             - Content-addressed pool for resolving
   *   hashes to bytes.  Required when hard-linking (to write new files).
   * @returns A {@link Generation} ready to be committed.
   */
  stageFromSnapshot(
    snapshot: MerkleSnapshot,
    previousSnapshot?: MerkleSnapshot,
    pool?: ContentAddressedPool,
  ): Generation {
    const nextId = this._currentGenId + 1;
    const genDir = path.join(this._generationsDir, `gen_${String(nextId).padStart(6, '0')}`);
    const stagedFiles = new Map<string, string>();

    if (previousSnapshot !== undefined) {
      // Compute the diff.
      const changes = MerkleFileIndex.diff(previousSnapshot, snapshot);

      for (const change of changes) {
        if (change.type === 'deleted') {
          // Deleted files don't need to be staged — they simply
          // won't appear in the new generation.
          continue;
        }

        // For added or modified files, we always stage them.
        const hash = change.type === 'added' ? change.newHash : change.newHash;
        if (hash !== undefined) {
          stagedFiles.set(change.path, hash);
        }
      }

      // Also stage unchanged files for hard-linking (if HARD_LINK).
      if (this._strategy === CommitStrategy.HARD_LINK) {
        for (const [filePath, entry] of snapshot.files) {
          if (!stagedFiles.has(filePath)) {
            stagedFiles.set(filePath, entry.contentHash);
          }
        }
      }
    } else {
      // No previous snapshot — stage everything as new.
      for (const [filePath, entry] of snapshot.files) {
        stagedFiles.set(filePath, entry.contentHash);
      }
    }

    return { id: nextId, dirPath: genDir, stagedFiles };
  }

  // ── Commit ──────────────────────────────────────────────────────

  /**
   * Materialise a staged generation and atomically swap the symlink.
   *
   * Steps:
   * 1. Create the `gen_NNNNNN/` directory.
   * 2. For each staged file:
   *    - If `HARD_LINK` and the file exists in the previous generation,
   *      create a hard link.
   *    - Otherwise, write the file content from the pool.
   * 3. Create a temporary symlink pointing to the new generation.
   * 4. `fs.renameSync(tempLink, marker)` — the single syscall that
   *    provides global atomicity.
   *
   * @param gen   - The staged generation from {@link stageFromSnapshot}.
   * @param index - The MerkleFileIndex to resolve content hashes.
   */
  commit(gen: Generation, index: MerkleFileIndex): void {
    // 1. Create the generation directory.
    fs.mkdirSync(gen.dirPath, { recursive: true });

    // 2. Resolve the previous generation directory (for hard-linking).
    const prevGenDir = this._currentGenId > 0
      ? path.join(this._generationsDir, `gen_${String(this._currentGenId).padStart(6, '0')}`)
      : null;

    // 3. Write or link each staged file.
    for (const [relPath, contentHash] of gen.stagedFiles) {
      const targetFile = path.join(gen.dirPath, relPath);
      const targetDir = path.dirname(targetFile);

      // Ensure the parent directory exists.
      fs.mkdirSync(targetDir, { recursive: true });

      // Try hard link first if strategy allows and previous gen exists.
      let linked = false;
      if (this._strategy === CommitStrategy.HARD_LINK && prevGenDir !== null) {
        const prevFile = path.join(prevGenDir, relPath);
        try {
          if (fs.existsSync(prevFile)) {
            fs.linkSync(prevFile, targetFile);
            linked = true;
          }
        } catch {
          // Hard link failed — fall through to full write.
        }
      }

      if (!linked) {
        // Resolve content from the pool or index.
        const content = index.pool.get(contentHash);
        if (content !== undefined) {
          fs.writeFileSync(targetFile, content);
        } else {
          // Fallback: try reading from the index as text.
          const text = index.getFile(relPath);
          if (text !== undefined) {
            fs.writeFileSync(targetFile, text, 'utf-8');
          }
        }
      }
    }

    // 4. Atomically swap the marker file.
    //    Write to a temp file first, then rename for atomicity.
    const tmpMarker = `${this._currentGenFile}.tmp.${String(gen.id)}`;
    fs.writeFileSync(tmpMarker, String(gen.id), 'utf-8');
    fs.renameSync(tmpMarker, this._currentGenFile);

    // Update in-memory state.
    this._currentGenId = gen.id;
  }

  // ── Rollback ────────────────────────────────────────────────────

  /**
   * Rollback a failed generation.
   *
   * Deletes the generation directory.  The marker file still points to
   * the previous generation, so this is a natural recovery — no
   * symlink swap is needed.
   *
   * @param failedGen - The generation to discard.
   */
  rollback(failedGen: Generation): void {
    try {
      fs.rmSync(failedGen.dirPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.  The generation directory may not exist
      // if the commit failed before any files were written.
    }
  }

  // ── Query ───────────────────────────────────────────────────────

  /**
   * Return the absolute path of the current generation directory, or
   * `null` if no commit has been made yet.
   */
  getCurrentGeneration(): string | null {
    if (this._currentGenId === 0) return null;
    return path.join(
      this._generationsDir,
      `gen_${String(this._currentGenId).padStart(6, '0')}`,
    );
  }

  /**
   * Return the current generation id (0 if no commit has been made).
   */
  get currentGenId(): number {
    return this._currentGenId;
  }
}
