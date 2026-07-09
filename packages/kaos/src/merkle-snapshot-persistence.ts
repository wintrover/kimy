/**
 * Persistent Merkle Snapshot — O(1) session restore.
 *
 * Serializes only the metadata layer (files Map + rootHash) to disk.
 * Content pool is excluded — files are hydrated on-demand (lazy).
 *
 * Storage format: JSON at `.axiom/index.snapshot.json`.
 * Binary format (msgpack/mmap) deferred to CAS Image phase.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { compareCanonicalPath } from './path';
import { dirname } from 'node:path';
import type { FileEntry, MerkleSnapshot } from './merkle-file-index';

/** Persisted snapshot schema v1 — the on-disk contract. */
export interface PersistedSnapshot {
  readonly version: 1;
  readonly rootHash: string;
  readonly files: readonly [string, FileEntry][];
  readonly savedAt: number;
}

/** Directory metadata stored on disk (v2). `knownEntries` is `string[]` on disk. */
export interface DirectoryMeta {
  readonly mtime: number;
  readonly entryCount: number;
  readonly childrenDirs: readonly string[];
  readonly knownEntries: readonly string[];
}

/** In-memory directory metadata. `knownEntries` is a `Set<string>` for O(1) lookups. */
export interface LoadedDirectoryMeta {
  readonly mtime: number;
  readonly entryCount: number;
  readonly childrenDirs: readonly string[];
  readonly knownEntries: Set<string>;
}

/** Persisted snapshot schema v2 — includes directory metadata. */
export interface PersistedSnapshotV2 {
  readonly version: 2;
  readonly rootHash: string;
  readonly files: readonly [string, FileEntry][];
  readonly directories: readonly [string, DirectoryMeta][];
  readonly savedAt: number;
}

/** In-memory loaded v2 snapshot with Set-converted knownEntries. */
export interface LoadedSnapshotV2 {
  readonly version: 2;
  readonly rootHash: string;
  readonly files: readonly [string, FileEntry][];
  readonly directories: Map<string, LoadedDirectoryMeta>;
  readonly savedAt: number;
}

/** Snapshot diff result. */
export interface SnapshotDiff {
  /** true when the snapshot can be used as-is — no rebuild needed. */
  readonly unchanged: boolean;
  /** Files whose mtime changed since the snapshot was saved. */
  readonly changed: readonly string[];
  /** Files present on disk but absent from the snapshot. */
  readonly added: readonly string[];
  /** Files present in the snapshot but absent from disk. */
  readonly removed: readonly string[];
}

const SNAPSHOT_VERSION_V1 = 1;
const SNAPSHOT_VERSION_V2 = 2;

/**
 * Serialize a MerkleFileIndex's metadata to a JSON file.
 *
 * Pool content is intentionally excluded — the pool is rebuilt lazily
 * when files are accessed through IndexedKaos.
 */
export async function saveSnapshot(
  files: ReadonlyMap<string, FileEntry>,
  rootHash: string,
  filePath: string,
): Promise<void> {
  const snapshot: PersistedSnapshot = {
    version: SNAPSHOT_VERSION_V1,
    rootHash,
    files: Array.from(files.entries()),
    savedAt: Date.now(),
  };

  const json = JSON.stringify(snapshot, null, 2);

  // Atomic write: write to tmp then rename
  const tmpPath = filePath + '.tmp';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Serialize a MerkleFileIndex's metadata and directory tree to a JSON file (v2).
 *
 * Includes per-directory metadata (mtime, entry count, child dirs, known entries)
 * so that `diffSnapshotV2` can prune unchanged directories during verification.
 */
export async function saveSnapshotV2(
  files: ReadonlyMap<string, FileEntry>,
  rootHash: string,
  filePath: string,
  dirMetaFn: (dirRelPath: string) => DirectoryMeta | undefined,
): Promise<void> {
  const directories: [string, DirectoryMeta][] = [];

  // Collect all directory paths from the files map.
  const dirPaths = new Set<string>();
  for (const relPath of files.keys()) {
    let walk = relPath;
    while (true) {
      const idx = walk.lastIndexOf('/');
      if (idx === -1) break;
      walk = walk.slice(0, idx);
      dirPaths.add(walk);
    }
    dirPaths.add('');
  }

  for (const dirPath of dirPaths) {
    const meta = dirMetaFn(dirPath);
    if (meta !== undefined) {
      directories.push([dirPath, meta]);
    }
  }

  const snapshot: PersistedSnapshotV2 = {
    version: SNAPSHOT_VERSION_V2,
    rootHash,
    files: Array.from(files.entries()).sort(([a], [b]) => compareCanonicalPath(a, b)),
    directories: directories.sort(([a], [b]) => compareCanonicalPath(a, b)),
    savedAt: Date.now(),
  };

  const json = JSON.stringify(snapshot, null, 2);

  // Atomic write: write to tmp then rename
  const tmpPath = filePath + '.tmp';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Load a persisted snapshot from disk.
 * Returns null if the file doesn't exist or is invalid.
 * Handles both v1 and v2 formats.
 */
export async function loadSnapshot(
  filePath: string,
): Promise<PersistedSnapshot | PersistedSnapshotV2 | null> {
  try {
    const json = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(json) as { version: number };

    if (parsed.version === SNAPSHOT_VERSION_V1) {
      const snap = parsed as unknown as PersistedSnapshot;
      if (typeof snap.rootHash !== 'string') return null;
      if (!Array.isArray(snap.files)) return null;
      return snap;
    }

    if (parsed.version === SNAPSHOT_VERSION_V2) {
      const snap = parsed as unknown as PersistedSnapshotV2;
      if (typeof snap.rootHash !== 'string') return null;
      if (!Array.isArray(snap.files)) return null;
      if (!Array.isArray(snap.directories)) return null;
      return snap;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Load a v2 snapshot and convert `knownEntries` arrays into Sets for O(1) lookups.
 * Returns null if the file doesn't exist, is invalid, or is not v2.
 */
export async function loadSnapshotV2(
  filePath: string,
): Promise<LoadedSnapshotV2 | null> {
  const raw = await loadSnapshot(filePath);
  if (raw === null || raw.version !== SNAPSHOT_VERSION_V2) return null;

  const v2 = raw as PersistedSnapshotV2;
  const directories = new Map<string, LoadedDirectoryMeta>();
  for (const [dirPath, meta] of v2.directories) {
    directories.set(dirPath, {
      mtime: meta.mtime,
      entryCount: meta.entryCount,
      childrenDirs: meta.childrenDirs,
      knownEntries: new Set(meta.knownEntries),
    });
  }

  return {
    version: SNAPSHOT_VERSION_V2,
    rootHash: v2.rootHash,
    files: v2.files,
    directories,
    savedAt: v2.savedAt,
  };
}

/**
 * Convert a PersistedSnapshot (v1 or v2) back to a MerkleSnapshot (in-memory format).
 */
export function toMerkleSnapshot(
  snapshot: PersistedSnapshot | PersistedSnapshotV2,
): MerkleSnapshot {
  return {
    rootHash: snapshot.rootHash,
    files: new Map(snapshot.files),
  };
}

/**
 * Compute a fast diff between a persisted snapshot and the current filesystem.
 *
 * Strategy: stat each file in the snapshot + scan for new files,
 * compare mtimes. Returns early when rootHash is unchanged.
 *
 * @param snapshot The persisted snapshot to diff against
 * @param statFn Function that returns {mtime} for a relative path, or null if not found
 * @param listDirFn Function that lists all relative file paths under the root
 */
export async function diffSnapshot(
  snapshot: PersistedSnapshot,
  statFn: (relPath: string) => Promise<{ mtime: number } | null>,
  listDirFn: () => Promise<string[]>,
): Promise<SnapshotDiff> {
  const snapshotFiles = new Map(snapshot.files);
  const changed: string[] = [];
  const removed: string[] = [];

  // Check each file in snapshot
  for (const [relPath, entry] of snapshotFiles) {
    const current = await statFn(relPath);
    if (current === null) {
      removed.push(relPath);
    } else if (current.mtime !== entry.mtime) {
      changed.push(relPath);
    }
  }

  // Check for new files
  const currentFiles = await listDirFn();
  const added: string[] = [];
  for (const relPath of currentFiles) {
    if (!snapshotFiles.has(relPath)) {
      added.push(relPath);
    }
  }

  const unchanged = changed.length === 0 && added.length === 0 && removed.length === 0;

  return { unchanged, changed, added, removed };
}

/**
 * Compute a fast diff between a v2 snapshot and the current filesystem using
 * dual-stream verification.
 *
 * Stream 1: stat each file in the snapshot (modify/delete detection).
 * Stream 2: verify directories for additions with mtime-based pruning.
 *   - If a directory's mtime matches the stored value → skip readdir,
 *     recurse into known children dirs only (Promise.all).
 *   - If mtime differs → readdir, check entries against knownEntries Set,
 *     recurse into new dirs.
 *
 * This avoids the O(N) glob() call when nothing has changed.
 *
 * @param snapshot The loaded v2 snapshot
 * @param fileStatFn Stat a file by relative path → {mtime} or null
 * @param dirStatFn Stat a directory by relative path → {mtime} or null
 * @param readdirFn Yield entry names from a directory by relative path
 * @param isDirFn Check if a full resolved path is a directory
 */
export async function diffSnapshotV2(
  snapshot: LoadedSnapshotV2,
  fileStatFn: (relPath: string) => Promise<{ mtime: number } | null>,
  dirStatFn: (relPath: string) => Promise<{ mtime: number } | null>,
  readdirFn: (relPath: string) => AsyncGenerator<string>,
  isDirFn: (fullPath: string) => Promise<boolean>,
): Promise<SnapshotDiff> {
  const snapshotFiles = new Map(snapshot.files);
  const changed: string[] = [];
  const removed: string[] = [];

  // Stream 1: stat each file for modify/delete detection (batch parallel).
  const BATCH_SIZE = 256;
  const fileEntries = [...snapshotFiles];
  for (let i = 0; i < fileEntries.length; i += BATCH_SIZE) {
    const batch = fileEntries.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async ([relPath, entry]) => {
        const current = await fileStatFn(relPath);
        return { relPath, entry, current };
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      if (result.status === 'rejected') {
        // 무결성 방어: 검증 실패한 파일은 보수적으로 '변경됨'으로 취급하여 재검증 유도
        changed.push(batch[j]![0]);
        continue;
      }
      const { relPath, entry, current } = result.value;
      if (current === null) removed.push(relPath);
      else if (Math.round(current.mtime * 1000) !== Math.round(entry.mtime * 1000))
        changed.push(relPath);
    }
  }

  // Stream 2: verify directory additions with mtime-based pruning.
  const added: string[] = [];

  async function verifyDirectoryAdditions(dirRelPath: string): Promise<void> {
    const meta = snapshot.directories.get(dirRelPath);
    const currentDirStat = await dirStatFn(dirRelPath);

    if (meta !== undefined && currentDirStat !== null && currentDirStat.mtime === meta.mtime) {
      // Directory mtime unchanged — skip readdir, recurse into known children dirs only.
      const recursePromises: Promise<void>[] = [];
      for (const childDir of meta.childrenDirs) {
        const childRelPath = dirRelPath === '' ? childDir : `${dirRelPath}/${childDir}`;
        recursePromises.push(verifyDirectoryAdditions(childRelPath));
      }
      await Promise.all(recursePromises);
    } else {
      // Directory mtime changed or no stored metadata — readdir and check.
      const knownEntries = meta?.knownEntries;
      const recursePromises: Promise<void>[] = [];

      for await (const entry of readdirFn(dirRelPath)) {
        if (knownEntries !== undefined && knownEntries.has(entry)) {
          // Known entry — check if it's a known child dir for recursion.
          if (meta !== undefined && meta.childrenDirs.includes(entry)) {
            const childRelPath = dirRelPath === '' ? entry : `${dirRelPath}/${entry}`;
            recursePromises.push(verifyDirectoryAdditions(childRelPath));
          }
          // Known file entry — already handled by Stream 1, skip.
        } else {
          // New entry not in knownEntries — check if it's a file.
          const fullPath = dirRelPath === '' ? entry : `${dirRelPath}/${entry}`;
          if (await isDirFn(fullPath)) {
            // New directory — recurse to find any files inside.
            recursePromises.push(verifyDirectoryAdditions(fullPath));
          } else {
            // New file — check if it's in snapshot files (handled by Stream 1)
            // or truly new.
            if (!snapshotFiles.has(fullPath)) {
              added.push(fullPath);
            }
          }
        }
      }

      // Also recurse into known children dirs that might have changes
      // even if not found in readdir (they should still be there, but
      // readdir may have missed them if mtime changed).
      if (meta !== undefined) {
        for (const childDir of meta.childrenDirs) {
          const childRelPath = dirRelPath === '' ? childDir : `${dirRelPath}/${childDir}`;
          // Only add if not already queued for recursion.
          const alreadyQueued = knownEntries !== undefined && knownEntries.has(childDir);
          if (!alreadyQueued) {
            recursePromises.push(verifyDirectoryAdditions(childRelPath));
          }
        }
      }

      await Promise.all(recursePromises);
    }
  }

  await verifyDirectoryAdditions('');

  const unchanged = changed.length === 0 && added.length === 0 && removed.length === 0;

  return { unchanged, changed, added, removed };
}
