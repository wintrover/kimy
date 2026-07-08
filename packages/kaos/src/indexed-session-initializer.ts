import { join } from 'pathe';

import type { Kaos } from './kaos';
import type { MerkleFileIndex } from './merkle-file-index';
import { MerkleFileIndex as MerkleFileIndexImpl } from './merkle-file-index';
import { IndexedKaos } from './indexed-kaos';
import { HermeticKaos } from './hermetic-kaos';
import { FileIndexBuilder, type BuildResult } from './file-index-builder';
import {
  loadSnapshot,
  saveSnapshot,
  saveSnapshotV2,
  toMerkleSnapshot,
  diffSnapshot,
  diffSnapshotV2,
  type PersistedSnapshot,
  type PersistedSnapshotV2,
} from './merkle-snapshot-persistence';

// ── Public types ────────────────────────────────────────────────────

/** State produced by {@link IndexedSessionInitializer.initialize}. */
export interface SessionIndexState {
  /** The shared CAS object pool. */
  readonly pool: BuildResult['pool'];
  /** The merkle file index for the workspace. */
  readonly index: MerkleFileIndex;
  /** IndexedKaos wrapping the delegate — use as toolKaos. */
  readonly indexedKaos: IndexedKaos;
  /** Build statistics. */
  readonly stats: BuildResult['stats'];
  /** Root hash of the initial index. */
  readonly rootHash: string;
}

/** Options for {@link IndexedSessionInitializer.initialize}. */
export interface InitializeOptions {
  /** Additional glob patterns to exclude from indexing. */
  excludePatterns?: string[];
  /** Maximum file size in bytes to index. */
  maxFileSize?: number;
  /** Whether to respect .gitignore files (default: `true`). */
  respectGitignore?: boolean;
}

// ── IndexedSessionInitializer ──────────────────────────────────────

/**
 * Builds the CAS pool + MerkleFileIndex at session start and provides
 * IndexedKaos / HermeticKaos instances.
 *
 * @example
 * ```ts
 * const local = await LocalKaos.create();
 * const init = new IndexedSessionInitializer(local);
 * const state = await init.initialize();
 *
 * // Use state.indexedKaos as the toolKaos for glob-backed tools.
 * // Glob operations are served from the in-memory index with zero disk I/O.
 *
 * // Spawn a subagent with a hermetic snapshot.
 * const hermetic = init.createSubagentKaos(state.index);
 * ```
 */
export class IndexedSessionInitializer {
  private readonly _delegate: Kaos;

  constructor(delegate: Kaos) {
    this._delegate = delegate;
  }

  /**
   * Build the index from the workspace root.
   *
   * 1. Attempts to load a persisted Merkle snapshot for O(1) restore.
   * 2. If the snapshot is unchanged vs. the live filesystem, restores
   *    the index in-memory without a full disk scan.
   * 3. Otherwise, creates a {@link FileIndexBuilder} with the delegate
   *    Kaos, scans the workspace, and persists a new snapshot.
   * 4. Wraps the result in an {@link IndexedKaos}.
   *
   * @param workspaceRoot - Absolute path to scan. Defaults to `delegate.getcwd()`.
   * @param options - Build options (exclude patterns, max file size, etc.).
   */
  async initialize(
    workspaceRoot?: string,
    options?: InitializeOptions,
  ): Promise<SessionIndexState> {
    const root = workspaceRoot ?? this._delegate.getcwd();
    const delegate = this._delegate;
    const snapshotPath = join(root, '.axiom', 'index.snapshot.json');

    // ── Try loading persisted snapshot ────────────────────────
    const persisted = await loadSnapshot(snapshotPath);
    if (persisted) {
      let diff: { unchanged: boolean; changed: readonly string[]; added: readonly string[]; removed: readonly string[] };

      if (persisted.version === 2 && 'directories' in persisted && persisted.directories) {
        // v2: dual-stream verification (no glob needed)
        const v2Persisted = persisted as PersistedSnapshotV2;

        // Convert on-disk DirectoryMeta to in-memory LoadedDirectoryMeta
        // (string[] → Set<string> for knownEntries).
        const directoriesMap = new Map<string, { mtime: number; entryCount: number; childrenDirs: readonly string[]; knownEntries: Set<string> }>();
        for (const [dirPath, meta] of v2Persisted.directories) {
          directoriesMap.set(dirPath, {
            mtime: meta.mtime,
            entryCount: meta.entryCount,
            childrenDirs: meta.childrenDirs,
            knownEntries: new Set(meta.knownEntries),
          });
        }

        const loadedV2 = {
          version: 2 as const,
          rootHash: v2Persisted.rootHash,
          files: v2Persisted.files,
          directories: directoriesMap,
          savedAt: v2Persisted.savedAt,
        };

        diff = await diffSnapshotV2(
          loadedV2,
          // fileStatFn: stat a file by relative path
          async (relPath) => {
            try {
              const fullPath = join(root, relPath);
              const st = await this._delegate.stat(fullPath, { followSymlinks: false });
              return { mtime: st.stMtime };
            } catch {
              return null;
            }
          },
          // dirStatFn: stat a directory by relative path
          async (relPath) => {
            try {
              const fullPath = relPath === '' ? root : join(root, relPath);
              const st = await this._delegate.stat(fullPath, { followSymlinks: false });
              return { mtime: Math.floor(st.stMtime * 1000) };
            } catch {
              return null;
            }
          },
          // readdirFn: yield entry names from a directory
          async function* readdirFn(relPath: string): AsyncGenerator<string> {
            const fullPath = relPath === '' ? root : join(root, relPath);
            for await (const entryPath of delegate.iterdir(fullPath)) {
              // Extract just the entry name from the full path.
              const name = entryPath.slice(fullPath.length + 1);
              if (name) yield name;
            }
          },
          // isDirFn: check if a full path is a directory
          async (fullPath: string) => {
            try {
              const st = await delegate.stat(fullPath, { followSymlinks: false });
              return (st.stMode & 0o170000) === 0o040000;
            } catch {
              return false;
            }
          },
        );
      } else {
        // v1 fallback: existing glob-based diff
        diff = await diffSnapshot(
          persisted as PersistedSnapshot,
          // statFn: stat a relative path
          async (relPath) => {
            try {
              const fullPath = join(root, relPath);
              const st = await delegate.stat(fullPath, { followSymlinks: false });
              return { mtime: st.stMtime };
            } catch {
              return null;
            }
          },
          // listDirFn: list all regular files under root (single snapshot pass)
          async () => {
            const vector = await delegate.snapshot(root);
            const files: string[] = [];
            for (const entry of vector) {
              if (entry.isFile) {
                files.push(entry.relPath);
              }
            }
            return files;
          },
        );
      }

      if (diff.unchanged) {
        // O(1) restore — no disk scan needed
        const index = MerkleFileIndexImpl.empty();
        const merkleSnapshot = toMerkleSnapshot(persisted);
        index.restoreFromSnapshot(merkleSnapshot);

        const indexedKaos = new IndexedKaos(this._delegate, index);
        return {
          pool: index.pool,
          index,
          indexedKaos,
          stats: {
            filesIndexed: persisted.files.length,
            filesSkipped: 0,
            totalBytes: 0,
            durationMs: 0,
          },
          rootHash: persisted.rootHash,
        };
      }
      // If changed, fall through to full rebuild
    }

    // ── Full build (existing path) ────────────────────────────
    const builder = new FileIndexBuilder(this._delegate);
    const buildResult = await builder.build({
      root,
      respectGitignore: options?.respectGitignore ?? true,
      excludePatterns: options?.excludePatterns,
      maxFileSize: options?.maxFileSize,
    });

    // ── Persist snapshot (non-blocking) ───────────────────────
    saveSnapshotV2(
      buildResult.index.files,
      buildResult.index.rootHash,
      snapshotPath,
      (dirRelPath) => {
        const dirNode = buildResult.index.dirs.get(dirRelPath);
        if (dirNode === undefined) return undefined;
        // Collect file entries in this directory (direct children only).
        const knownEntries: string[] = [...dirNode.children];
        // Collect child directory names.
        const childrenDirs: string[] = [];
        for (const child of dirNode.children) {
          const childPath = dirRelPath === '' ? child : `${dirRelPath}/${child}`;
          if (buildResult.index.dirs.has(childPath)) {
            childrenDirs.push(child);
          }
        }
        // Compute mtime as max of all file mtimes in this directory (ms, floored).
        let maxMtime = 0;
        for (const child of dirNode.children) {
          const childPath = dirRelPath === '' ? child : `${dirRelPath}/${child}`;
          const entry = buildResult.index.files.get(childPath);
          if (entry !== undefined) {
            maxMtime = Math.max(maxMtime, Math.floor(entry.mtime * 1000));
          }
        }
        return {
          mtime: maxMtime,
          entryCount: knownEntries.length,
          childrenDirs,
          knownEntries,
        };
      },
    ).catch(() => {}); // best-effort, don't fail the session

    const indexedKaos = new IndexedKaos(this._delegate, buildResult.index);

    return {
      pool: buildResult.pool,
      index: buildResult.index,
      indexedKaos,
      stats: buildResult.stats,
      rootHash: buildResult.index.rootHash,
    };
  }

  /**
   * Create a {@link HermeticKaos} for a subagent from an existing index.
   *
   * The subagent gets a CoW snapshot — its writes refresh the snapshot
   * but do not affect the main index.
   *
   * @param index - The merkle file index to give the subagent.
   */
  createSubagentKaos(index: MerkleFileIndex): HermeticKaos {
    return new HermeticKaos(this._delegate, index);
  }
}
