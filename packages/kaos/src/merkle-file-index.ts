import { createHash } from 'node:crypto';

import type { Kaos } from './kaos';
import { ContentAddressedPool } from './object-pool';
import type { ContentVector } from './types';

// ── Public types ────────────────────────────────────────────────────

/** Metadata for a single tracked file. */
export interface FileEntry {
  /** SHA-256 hex digest of the file content (key into the content pool). */
  readonly contentHash: string;
  /** File size in bytes. */
  readonly size: number;
  /** Last-modified time as a Unix timestamp in seconds (fractional). */
  readonly mtime: number;
}

/** A node in the directory merkle tree. */
export interface DirNode {
  /** Direct child names (file basenames and subdirectory names). */
  readonly children: Set<string>;
  /** SHA-256 hex digest of the directory contents. */
  readonly hash: string;
}

/** An immutable snapshot of the index at a point in time. */
export interface MerkleSnapshot {
  /** The merkle root hash for the entire tree. */
  readonly rootHash: string;
  /** Shallow copy of the file map at snapshot time. */
  readonly files: ReadonlyMap<string, FileEntry>;
}

/** Describes a single file-level change between two snapshots. */
export interface MerkleFileChange {
  /** Relative path of the changed file. */
  readonly path: string;
  /** Nature of the change. */
  readonly type: 'added' | 'modified' | 'deleted';
  /** Content hash before the change (present for `modified` and `deleted`). */
  readonly oldHash?: string;
  /** Content hash after the change (present for `added` and `modified`). */
  readonly newHash?: string;
}

// ── Glob matching ───────────────────────────────────────────────────

/**
 * Match a single path segment against a glob segment.
 *
 * Supports `*` (any characters except `/`), `?` (single character), and
 * backslash-escaping of glob metacharacters.
 */
function matchSegment(pattern: string, segment: string): boolean {
  let pi = 0;
  let si = 0;

  while (pi < pattern.length) {
    const pc = pattern[pi];

    if (pc === '*') {
      pi++;
      if (pi === pattern.length) return true;
      for (let i = si; i <= segment.length; i++) {
        if (matchSegment(pattern.slice(pi), segment.slice(i))) return true;
      }
      return false;
    }

    if (pc === '?') {
      if (si >= segment.length) return false;
      pi++;
      si++;
      continue;
    }

    if (pc === '\\') {
      pi++;
      if (pi >= pattern.length) return false;
      if (segment[si] !== pattern[pi]) return false;
      pi++;
      si++;
      continue;
    }

    if (segment[si] !== pc) return false;
    pi++;
    si++;
  }

  return si === segment.length;
}

/**
 * Recursively match pattern segments against path segments.
 *
 * `**` consumes zero or more path segments; other segments match exactly one.
 */
function matchSegments(pattern: string[], pi: number, pathParts: string[], xi: number): boolean {
  if (pi === pattern.length && xi === pathParts.length) return true;
  if (pi === pattern.length) return false;

  const seg = pattern[pi]!;

  if (seg === '**') {
    // Match zero segments (skip **)
    if (matchSegments(pattern, pi + 1, pathParts, xi)) return true;
    // Match one or more segments (consume one path part, stay on **)
    for (let i = xi; i < pathParts.length; i++) {
      if (matchSegments(pattern, pi, pathParts, i + 1)) return true;
    }
    return false;
  }

  if (xi >= pathParts.length) return false;

  if (matchSegment(seg, pathParts[xi]!)) {
    return matchSegments(pattern, pi + 1, pathParts, xi + 1);
  }

  return false;
}

/**
 * Test whether a relative file path matches a glob pattern.
 *
 * Supported syntax:
 * - `*` — matches any characters except `/`
 * - `**` — matches zero or more path segments
 * - `?` — matches exactly one character (not `/`)
 * - `\` — escapes the next character
 *
 * @param pattern  - Glob pattern (forward-slash separated).
 * @param filePath - Relative file path (forward-slash separated).
 * @returns `true` if the path matches the pattern.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = filePath.split('/');
  return matchSegments(patternParts, 0, pathParts, 0);
}

// ── Merkle helpers ──────────────────────────────────────────────────

const EMPTY_DIR_HASH = createHash('sha256').update('').digest('hex');

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

function sortedBytes(items: string[]): string[] {
  return [...items].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * Normalize a relative path: convert backslashes to forward slashes,
 * strip a leading `./`.
 */
function normalizeRelativePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

function parentDir(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? '' : relativePath.slice(0, idx);
}

function basename(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

/**
 * Compute the merkle hash of a single directory, resolving child hashes
 * from both the `dirs` map (for subdirectories) and the `files` map
 * (for leaf files).
 */
function computeDirHash(
  dirPath: string,
  files: Map<string, FileEntry>,
  dirs: Map<string, DirNode>,
): string {
  const node = dirs.get(dirPath);
  if (node === undefined || node.children.size === 0) return EMPTY_DIR_HASH;

  const sorted = sortedBytes([...node.children]);
  const parts: string[] = [];

  for (const child of sorted) {
    const childRelPath = dirPath === '' ? child : `${dirPath}/${child}`;
    const dirChild = dirs.get(childRelPath);
    const fileChild = files.get(childRelPath);

    const childHash = dirChild
      ? dirChild.hash
      : fileChild
        ? fileChild.contentHash
        : EMPTY_DIR_HASH;

    parts.push(`${child}:${childHash}`);
  }

  return sha256(parts.join(''));
}

/**
 * Recompute merkle hashes from `dirPath` upward to the root (`''`).
 */
function recomputeHashesUp(
  dirPath: string,
  files: Map<string, FileEntry>,
  dirs: Map<string, DirNode>,
): void {
  const chain: string[] = [];
  let walk = dirPath;
  while (true) {
    chain.push(walk);
    if (walk === '') break;
    walk = parentDir(walk);
  }

  // Recompute bottom-up (deepest first).
  for (let i = chain.length - 1; i >= 0; i--) {
    const dir = chain[i]!;
    const node = dirs.get(dir);
    if (node) {
      const newHash = computeDirHash(dir, files, dirs);
      dirs.set(dir, { children: node.children, hash: newHash });
    }
  }
}

// ── MerkleFileIndex ─────────────────────────────────────────────────

/**
 * A Merkle-tree-based file index that stores file content hashes (not
 * content) and supports glob matching purely from memory.
 *
 * Every mutation (`writeFile`, `deleteFile`) recomputes merkle hashes from
 * the affected leaf up to the root, making the tree tamper-evident and
 * enabling efficient snapshotting / diffing.
 *
 * ```ts
 * const vector = await kaos.snapshot(rootDir);
 * const index = MerkleFileIndex.buildFromVector(vector);
 * console.log(index.rootHash);
 *
 * const files = index.glob('src/*.ts');
 * ```
 */
export class MerkleFileIndex {
  /** Relative path → file metadata. */
  readonly files: Map<string, FileEntry>;
  /** Relative directory path → directory node. */
  readonly dirs: Map<string, DirNode>;
  /** The content-addressed pool shared across the index lifetime. */
  readonly pool: ContentAddressedPool;
  /** SHA-256 merkle root of the entire directory tree. */
  rootHash: string;
  /** The root directory path used when this index was built. */
  readonly rootDir: string;

  private constructor(
    rootDir: string,
    files: Map<string, FileEntry>,
    dirs: Map<string, DirNode>,
    pool: ContentAddressedPool,
    rootHash: string,
  ) {
    this.rootDir = rootDir;
    this.files = files;
    this.dirs = dirs;
    this.pool = pool;
    this.rootHash = rootHash;
  }

  /**
   * Create an empty index with no files.
   *
   * @param pool - Optional pre-existing pool. A fresh pool is created if omitted.
   */
  static empty(pool?: ContentAddressedPool): MerkleFileIndex {
    const sharedPool = pool ?? new ContentAddressedPool();
    const files = new Map<string, FileEntry>();
    const dirs = new Map<string, DirNode>();
    dirs.set('', { children: new Set(), hash: EMPTY_DIR_HASH });
    return new MerkleFileIndex('', files, dirs, sharedPool, EMPTY_DIR_HASH);
  }

  // ── Static factories ──────────────────────────────────────────────

  /**
   * Build a `MerkleFileIndex` from a pre-captured {@link ContentVector}.
   *
   * This is Stage 2 of the deterministic pipeline — the vector is typically
   * obtained from `kaos.snapshot()` (Stage 1) and contains all file content
   * and hashes already computed.
   *
   * @param vector - Immutable array of {@link FsEntry} objects.
   * @param rootDir - The directory the vector was captured from (used as the
   *   index root). Defaults to `''`.
   * @param pool - Optional pre-existing pool to store content into.
   * @returns A fully-built `MerkleFileIndex`.
   */
  static buildFromVector(
    vector: ContentVector,
    rootDir?: string,
    pool?: ContentAddressedPool,
  ): MerkleFileIndex {
    const resolvedRoot = rootDir ?? '';
    const sharedPool = pool ?? new ContentAddressedPool();
    const files = new Map<string, FileEntry>();
    const dirs = new Map<string, DirNode>();

    // Ensure root dir exists in the map.
    dirs.set('', { children: new Set(), hash: EMPTY_DIR_HASH });

    for (const entry of vector) {
      // Skip directories — the directory tree is built from file paths.
      if (!entry.isFile) continue;

      // Store content in the pool. snapshot() already computed contentHash,
      // but the pool needs the actual bytes for later retrieval.
      let contentHash: string;
      if (entry.content !== null) {
        contentHash = sharedPool.put(entry.content);
      } else {
        // No content available — use the hash provided by snapshot.
        contentHash = entry.contentHash;
      }

      files.set(entry.relPath, {
        contentHash,
        size: entry.size,
        mtime: entry.mtime,
      });
    }

    // Build directory tree from file paths.
    buildDirTree(files, dirs);

    // Compute root hash.
    const rootHash = computeDirHash('', files, dirs);

    return new MerkleFileIndex(resolvedRoot, files, dirs, sharedPool, rootHash);
  }

  /**
   * Build a `MerkleFileIndex` by walking a {@link Kaos} instance.
   *
   * Uses `kaos.snapshot()` (Stage 1) to capture all file content in a single
   * I/O pass, then delegates to {@link buildFromVector} (Stage 2) for
   * index construction.
   *
   * @param kaos  - The filesystem abstraction to read from.
   * @param root  - Absolute directory to index. Defaults to `kaos.getcwd()`.
   * @param pool  - Optional pre-existing pool to share content with.
   * @returns A fully-built `MerkleFileIndex`.
   */
  static async buildFrom(
    kaos: Kaos,
    root?: string,
    pool?: ContentAddressedPool,
  ): Promise<MerkleFileIndex> {
    const rootDir = root ?? kaos.getcwd();
    const vector = await kaos.snapshot(rootDir);
    return MerkleFileIndex.buildFromVector(vector, rootDir, pool);
  }

  // ── Query ─────────────────────────────────────────────────────────

  /**
   * Retrieve the text content of a file stored in the index.
   *
   * Content is decoded from the pool via the file's content hash.
   *
   * @param relativePath - Forward-slash–separated relative path.
   * @returns The file content as a UTF-8 string, or `undefined` if not found.
   */
  getFile(relativePath: string): string | undefined {
    const entry = this.files.get(relativePath);
    if (entry === undefined) return undefined;
    const buf = this.pool.get(entry.contentHash);
    return buf?.toString('utf-8');
  }

  /**
   * Yield relative file paths that match `pattern`.
   *
   * Matching is performed in-memory against the file map — no I/O occurs.
   *
   * @param pattern - Glob pattern (forward-slash separated).
   * @yields Matching relative file paths.
   */
  async *glob(pattern: string): AsyncGenerator<string> {
    for (const filePath of this.files.keys()) {
      if (matchGlob(pattern, filePath)) {
        yield filePath;
      }
    }
  }

  /**
   * Retrieve the text content for a file in the index.
   *
   * @param relativePath - Path relative to the index root.
   * @returns The file content as a UTF-8 string, or `undefined` if not found.
   */
  getFileContent(relativePath: string): string | undefined {
    const normalizedPath = normalizeRelativePath(relativePath);
    const entry = this.files.get(normalizedPath);
    if (entry === undefined) return undefined;
    const buf = this.pool.get(entry.contentHash);
    if (buf === undefined) return undefined;
    return buf.toString('utf-8');
  }

  /**
   * Retrieve the metadata entry for a file in the index.
   *
   * @param relativePath - Path relative to the index root.
   * @returns The {@link FileEntry}, or `undefined` if not found.
   */
  getEntry(relativePath: string): FileEntry | undefined {
    return this.files.get(normalizeRelativePath(relativePath));
  }

  /**
   * List the direct children of a directory.
   *
   * @param dirPath - Directory path relative to the index root (or `''` for root).
   * @returns An array of child basenames, or `undefined` if the directory
   *   is not tracked.
   */
  listDir(dirPath: string): string[] | undefined {
    const normalizedPath = normalizeRelativePath(dirPath);
    const node = this.dirs.get(normalizedPath);
    if (node === undefined) return undefined;
    return [...node.children];
  }

  /**
   * Ensure a directory exists in the index.
   *
   * @param dirPath - Directory path relative to the index root.
   * @param options.parents - When `true` (the default for `IndexedKaos.mkdir`),
   *   also create all ancestor directories so the tree stays connected.
   */
  ensureDir(dirPath: string, options?: { parents?: boolean }): void {
    const normalizedPath = normalizeRelativePath(dirPath);

    // Always ensure parent dirs exist so the tree stays connected.
    ensureParentDirs(normalizedPath, this.dirs);

    // Create this directory if it doesn't exist.
    if (!this.dirs.has(normalizedPath)) {
      this.dirs.set(normalizedPath, { children: new Set(), hash: EMPTY_DIR_HASH });
    }
  }

  // ── Mutation ──────────────────────────────────────────────────────

  /**
   * Add or update a file in the index.
   *
   * The content is stored in the pool, a new {@link FileEntry} is created,
   * and merkle hashes are recomputed from the file's parent directory up
   * to the root.
   *
   * @param relativePath - Path relative to the index root (forward slashes).
   * @param content      - Raw file content (Buffer or string).
   * @param mtime        - Optional modification timestamp. Defaults to `Date.now() / 1000`.
   * @returns The new content hash for the file.
   */
  writeFile(relativePath: string, content: Buffer | string, mtime?: number): string {
    const normalizedPath = normalizeRelativePath(relativePath);
    const ts = mtime ?? Date.now() / 1000;
    const contentBuf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

    // Ensure parent directories exist in the tree.
    ensureParentDirs(normalizedPath, this.dirs);

    const contentHash = this.pool.put(contentBuf);

    // Update or insert the file entry.
    this.files.set(normalizedPath, { contentHash, size: contentBuf.length, mtime: ts });

    // Add to parent dir's children set.
    const parentPath = parentDir(normalizedPath);
    const childName = basename(normalizedPath);
    const parentDirNode = this.dirs.get(parentPath);
    if (parentDirNode) {
      parentDirNode.children.add(childName);
    }

    // Recompute hashes from parent directory up to root.
    recomputeHashesUp(parentPath, this.files, this.dirs);

    // Recompute root.
    this.rootHash = computeDirHash('', this.files, this.dirs);

    return contentHash;
  }

  /**
   * Remove a file from the index.
   *
   * The file entry is deleted, the file name is removed from its parent
   * directory's children, and merkle hashes are recomputed.
   *
   * @param relativePath - Path relative to the index root.
   * @returns `true` if the file existed and was removed.
   */
  deleteFile(relativePath: string): boolean {
    const normalizedPath = normalizeRelativePath(relativePath);

    const existed = this.files.delete(normalizedPath);
    if (!existed) return false;

    // Remove from parent dir's children.
    const parentPath = parentDir(normalizedPath);
    const childName = basename(normalizedPath);
    const parentDirNode = this.dirs.get(parentPath);
    if (parentDirNode) {
      parentDirNode.children.delete(childName);
    }

    // Clean up empty ancestor directories (but keep the root).
    pruneEmptyDirs(this.dirs, parentPath);

    // Recompute hashes from parent directory up to root.
    recomputeHashesUp(parentPath, this.files, this.dirs);

    // Recompute root.
    this.rootHash = computeDirHash('', this.files, this.dirs);

    return true;
  }

  // ── Pool accessor ────────────────────────────────────────────────

  /**
   * Return the underlying content-addressed pool.
   */
  getPool(): ContentAddressedPool {
    return this.pool;
  }

  // ── Snapshot restore ─────────────────────────────────────────────

  /**
   * Replace the current index state from a snapshot.
   *
   * This clears the file map and rebuilds the directory tree from the
   * snapshot's file entries, then recomputes the root merkle hash.
   *
   * @param snapshot - The snapshot to restore from.
   */
  restoreFromSnapshot(snapshot: MerkleSnapshot): void {
    this.files.clear();
    for (const [relPath, entry] of snapshot.files) {
      this.files.set(relPath, entry);
    }

    this.dirs.clear();
    buildDirTree(this.files, this.dirs);

    this.rootHash = computeDirHash('', this.files, this.dirs);
  }

  // ── Snapshots & diffing ───────────────────────────────────────────

  /**
   * Create a lightweight snapshot of the current index state.
   *
   * The snapshot captures the root hash and a shallow copy of the files
   * map. It does not deep-copy content or pool entries.
   */
  branch(): MerkleSnapshot {
    return {
      rootHash: this.rootHash,
      files: new Map(this.files),
    };
  }

  /**
   * Compare two snapshots and return the list of file-level changes.
   *
   * If the root hashes are identical, the snapshots are equivalent and an
   * empty array is returned without iterating file maps.
   *
   * @param before - The base snapshot.
   * @param after  - The head snapshot.
   * @returns A list of {@link MerkleFileChange} describing the diff.
   */
  static diff(before: MerkleSnapshot, after: MerkleSnapshot): MerkleFileChange[] {
    if (before.rootHash === after.rootHash) return [];

    const changes: MerkleFileChange[] = [];

    // Collect all file paths from both snapshots.
    const allPaths = new Set([...before.files.keys(), ...after.files.keys()]);

    for (const filePath of allPaths) {
      const oldEntry = before.files.get(filePath);
      const newEntry = after.files.get(filePath);

      if (oldEntry === undefined && newEntry !== undefined) {
        changes.push({
          path: filePath,
          type: 'added',
          newHash: newEntry.contentHash,
        });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        changes.push({
          path: filePath,
          type: 'deleted',
          oldHash: oldEntry.contentHash,
        });
      } else if (
        oldEntry !== undefined &&
        newEntry !== undefined &&
        oldEntry.contentHash !== newEntry.contentHash
      ) {
        changes.push({
          path: filePath,
          type: 'modified',
          oldHash: oldEntry.contentHash,
          newHash: newEntry.contentHash,
        });
      }
    }

    return changes;
  }
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Ensure that every ancestor directory of `relativePath` exists in `dirs`,
 * creating intermediate DirNodes as needed. Also ensures the root entry.
 */
function ensureParentDirs(relativePath: string, dirs: Map<string, DirNode>): void {
  if (!dirs.has('')) {
    dirs.set('', { children: new Set(), hash: EMPTY_DIR_HASH });
  }

  const parts = relativePath.split('/');
  let accumulated = '';

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    accumulated = accumulated === '' ? part : `${accumulated}/${part}`;

    if (!dirs.has(accumulated)) {
      dirs.set(accumulated, { children: new Set(), hash: EMPTY_DIR_HASH });
    }
  }
}

/**
 * Remove empty directories (no children) upward from `dirPath` toward
 * the root. Stops at the root directory (`''`), which is always kept.
 */
function pruneEmptyDirs(dirs: Map<string, DirNode>, dirPath: string): void {
  let current = dirPath;
  while (current !== '') {
    const node = dirs.get(current);
    if (node === undefined || node.children.size > 0) break;

    dirs.delete(current);

    // Remove from parent's children set.
    const parent = parentDir(current);
    const name = basename(current);
    const parentNode = dirs.get(parent);
    if (parentNode) {
      parentNode.children.delete(name);
    }

    current = parent;
  }
}

/**
 * Build the directory tree from the file map, populating `dirs`.
 *
 * Creates a DirNode for every directory that contains files or
 * subdirectories, and wires each child to its parent.
 */
function buildDirTree(files: Map<string, FileEntry>, dirs: Map<string, DirNode>): void {
  // Ensure root exists.
  if (!dirs.has('')) {
    dirs.set('', { children: new Set(), hash: EMPTY_DIR_HASH });
  }

  // Create DirNodes for all intermediate directories.
  for (const filePath of files.keys()) {
    const parts = filePath.split('/');
    let accumulated = '';

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      accumulated = accumulated === '' ? part : `${accumulated}/${part}`;

      if (!dirs.has(accumulated)) {
        dirs.set(accumulated, { children: new Set(), hash: EMPTY_DIR_HASH });
      }
    }
  }

  // Wire file children to their parent directories.
  for (const filePath of files.keys()) {
    const childName = basename(filePath);
    const parentPath = parentDir(filePath);
    const parentNode = dirs.get(parentPath);
    if (parentNode) {
      parentNode.children.add(childName);
    }
  }

  // Wire subdirectory children to their parent directories.
  for (const dirPath of dirs.keys()) {
    if (dirPath === '') continue;
    const parentPath = parentDir(dirPath);
    const name = basename(dirPath);
    const parentNode = dirs.get(parentPath);
    if (parentNode) {
      parentNode.children.add(name);
    }
  }
}
