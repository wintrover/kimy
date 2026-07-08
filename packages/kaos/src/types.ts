/**
 * KAOS stat result, mirroring Python's os.stat_result fields.
 */
export interface StatResult {
  stMode: number;
  stIno: number;
  stDev: number;
  stNlink: number;
  stUid: number;
  stGid: number;
  stSize: number;
  stAtime: number;
  stMtime: number;
  stCtime: number;
}

/**
 * A single filesystem entry captured during Stage 1 (I/O boundary).
 * After Stage 1 completes, no further disk I/O is needed.
 */
export interface FsEntry {
  /** Path relative to the snapshot root (forward-slash separators). */
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  /** File size in bytes (0 for directories). */
  readonly size: number;
  /** Unix timestamp in seconds (0 for directories). */
  readonly mtime: number;
  /** SHA-256 hex digest ('' for directories). */
  readonly contentHash: string;
  /** File content buffer (null for directories). Used by ContentAddressedPool in Stage 2. */
  readonly content: Buffer | null;
}

/** Immutable array of filesystem entries — the output of Stage 1. */
export type ContentVector = readonly FsEntry[];

/** Options for Kaos.snapshot(). */
export interface SnapshotOptions {
  /** Directory names to skip (e.g. node_modules, .git). */
  readonly excludeDirs?: Set<string>;
  /** Whether to follow symbolic links. Default: false. */
  readonly followSymlinks?: boolean;
  /** Whether to respect .gitignore rules. Default: true. */
  readonly respectGitignore?: boolean;
  /** Additional glob-style exclude patterns (relative to root). */
  readonly excludePatterns?: readonly string[];
  /** Maximum file size in bytes to include. Default: 10MB. */
  readonly maxFileSize?: number;
}
