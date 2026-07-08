import type { Kaos } from './kaos';
import { MerkleFileIndex } from './merkle-file-index';
import { ContentAddressedPool } from './object-pool';
import type { ContentVector } from './types';

// ── Public types ──────────────────────────────────────────────────────

/** Configuration for {@link FileIndexBuilder.build}. */
export interface BuildOptions {
  /** Root directory to scan. */
  root: string;
  /** Whether to respect `.gitignore` files (default: `true`). */
  respectGitignore?: boolean;
  /** Additional glob patterns to exclude from indexing. */
  excludePatterns?: string[];
  /** Maximum file size in bytes to index (default: 10 MB). */
  maxFileSize?: number;
}

/** Summary statistics for a build run. */
export interface BuildStats {
  /** Number of files that were read and stored in the index. */
  filesIndexed: number;
  /** Number of files skipped (gitignore / exclude / too large / error). */
  filesSkipped: number;
  /** Total bytes of content stored in the pool. */
  totalBytes: number;
  /** Wall-clock duration of the build in milliseconds. */
  durationMs: number;
}

/** The outcome of a build run. */
export interface BuildResult {
  /** The completed merkle file index. */
  index: MerkleFileIndex;
  /** The content-addressed pool holding indexed file content. */
  pool: ContentAddressedPool;
  /** Summary statistics. */
  stats: BuildStats;
}

// ── Internal gitignore types ──────────────────────────────────────────

/** A single parsed gitignore rule. */
interface GitignoreRule {
  /** Compiled regex to test relative paths against. */
  regex: RegExp;
  /** `true` when the rule is preceded by `!` (negation). */
  negated: boolean;
  /** `true` when the original pattern ended with `/` (directory-only). */
  directoryOnly: boolean;
}

// ── FileIndexBuilder ──────────────────────────────────────────────────

/**
 * One-time file system scanner that builds a {@link MerkleFileIndex} from
 * a {@link Kaos} instance.
 *
 * The builder walks the directory tree under a root, applies `.gitignore`
 * rules (optionally), filters by size and exclude patterns, then reads
 * each qualifying file into a content-addressed pool. The result carries
 * the index, pool, and aggregate statistics.
 *
 * ```ts
 * const kaos = await LocalKaos.create();
 * const builder = new FileIndexBuilder(kaos);
 * const { index, pool, stats } = await builder.build({ root: '/my/project' });
 * console.log(`Indexed ${stats.filesIndexed} files, root=${index.rootHash}`);
 * ```
 */
export class FileIndexBuilder {
  private readonly _kaos: Kaos;

  constructor(kaos: Kaos) {
    this._kaos = kaos;
  }

  /**
   * Stage 2: Deterministic kernel — synchronous pure function.
   * Converts a ContentVector (from Stage 1 snapshot) into a MerkleFileIndex.
   * No I/O, no async, no side effects beyond the returned objects.
   */
  static buildFromVector(vector: ContentVector): {
    index: MerkleFileIndex;
    pool: ContentAddressedPool;
    stats: BuildStats;
  } {
    const pool = new ContentAddressedPool();
    const index = MerkleFileIndex.empty(pool);
    let filesIndexed = 0;
    let totalBytes = 0;

    for (const entry of vector) {
      if (!entry.isFile || entry.content === null) continue;
      index.writeFile(entry.relPath, entry.content, entry.mtime);
      filesIndexed++;
      totalBytes += entry.size;
    }

    return {
      index,
      pool,
      stats: {
        filesIndexed,
        filesSkipped: vector.length - filesIndexed,
        totalBytes,
        durationMs: 0, // Stage 2 has no I/O — duration is negligible
      },
    };
  }

  /**
   * Scan the filesystem and build the index.
   *
   * Delegates to Stage 1 (`kaos.snapshot`) for I/O and Stage 2
   * (`buildFromVector`) for the deterministic kernel.
   *
   * @param options - Build configuration.
   * @returns The completed index, pool, and statistics.
   */
  async build(options: BuildOptions): Promise<BuildResult> {
    const startTime = Date.now();

    // Stage 1: I/O boundary
    const vector = await this._kaos.snapshot(options.root, {
      respectGitignore: options.respectGitignore,
      excludePatterns: options.excludePatterns,
      maxFileSize: options.maxFileSize,
    });

    // Stage 2: deterministic kernel
    const result = FileIndexBuilder.buildFromVector(vector);
    result.stats.durationMs = Date.now() - startTime;
    return result;
  }
}

// ── Gitignore parsing ─────────────────────────────────────────────────

/**
 * Parse the text content of a `.gitignore` file into an ordered list of
 * rules.  Rules are evaluated in order — the **last** matching rule wins,
 * following standard git semantics.
 *
 * Supported syntax:
 * - Blank lines and `#` comments are ignored.
 * - Trailing whitespace (before the comment or end) is stripped.
 * - `!` prefix negates the pattern.
 * - Trailing `/` restricts the rule to directories.
 * - `*` matches any characters except `/`.
 * - `?` matches exactly one non-`/` character.
 * - `[...]` is a character class.
 * - A pattern **without** `/` matches against the basename only.
 * - A pattern **with** `/` (or a leading `/`) matches against the full
 *   relative path.
 */
export function parseGitignoreContent(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];

  for (const rawLine of content.split('\n')) {
    // Strip trailing whitespace (git strips trailing SP and TAB before
    // checking for comments or patterns).
    const line = rawLine.replace(/[\t ]+$/, '');
    if (line === '' || line.startsWith('#')) continue;

    let negated = false;
    let pattern = line;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }

    let directoryOnly = false;
    if (pattern.endsWith('/') && !pattern.endsWith('//')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    // A leading `/` anchors the pattern to the root; strip it for the
    // regex but mark as anchored.
    const regex = gitignorePatternToRegex(pattern);

    rules.push({ regex, negated, directoryOnly });
  }

  return rules;
}

// ── Gitignore pattern → RegExp ────────────────────────────────────────

/**
 * Convert a single gitignore glob pattern (already stripped of leading `!`
 * and trailing `/`) into a `RegExp` that tests against a forward-slash–
 * separated relative path.
 */
export function gitignorePatternToRegex(pattern: string): RegExp {
  // Patterns containing `/` match against the full relative path.
  // Patterns without `/` match against just the basename.
  const hasSlash = pattern.includes('/');

  let regexStr: string;
  if (hasSlash) {
    // Strip a leading `/` — it means "anchored to root" which we
    // represent by anchoring the regex.
    const stripped = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    regexStr = '^' + globToRegexBody(stripped) + '(?:/.*)?$';
  } else {
    // Basename-only: match the last path segment.
    regexStr = '(?:^|/)' + globToRegexBody(pattern) + '$';
  }

  return new RegExp(regexStr);
}

/**
 * Convert the body of a glob pattern (no anchoring logic) into a regex
 * fragment.
 */
function globToRegexBody(pattern: string): string {
  let result = '';
  const len = pattern.length;
  let i = 0;

  while (i < len) {
    const ch = pattern[i];

    if (ch === undefined) break;

    if (ch === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        // `**` — match zero or more path segments.
        result += '.*';
        i += 2;
        // Consume an optional trailing `/` after `**` so that `**/foo`
        // and `**foo` behave the same at the boundary.
        if (pattern[i] === '/') i++;
      } else {
        // Single `*` — match within a single path segment.
        result += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      result += '[^/]';
      i++;
    } else if (ch === '[') {
      // Copy the character class verbatim until the closing `]`.
      let j = i + 1;
      while (j < len && pattern[j] !== ']') {
        j++;
      }
      if (j < len) {
        // Include the closing `]`.
        result += pattern.slice(i, j + 1);
        i = j + 1;
      } else {
        // Unclosed bracket — treat `[` as a literal.
        result += '\\[';
        i++;
      }
    } else {
      result += escapeRegexMeta(ch);
      i++;
    }
  }

  return result;
}

/**
 * Escape a single character for use inside a regex.
 */
function escapeRegexMeta(ch: string): string {
  // Characters that carry special meaning in regex syntax.
  if ('\\^$.|?*+(){}[]'.includes(ch)) {
    return '\\' + ch;
  }
  return ch;
}


