/**
 * SearchWorkspaceTool — intent-based workspace structure discovery.
 *
 * Scores files against a natural-language intent using path/filename
 * keyword matching, identifier extraction from text files, and a
 * recency boost. Results are returned as a compact tree with identifier
 * tags, bounded to ~2000 characters of output.
 *
 * Uses `kaos.glob` + `kaos.stat` for filesystem access — no external
 * search services required.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { createAjvValidateArgs } from '../../args-validator';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import SEARCH_WORKSPACE_DESCRIPTION from './search-workspace.md?raw';

export const SearchWorkspaceInputSchema = z.object({
  intent: z
    .string()
    .describe(
      'Natural-language description of what you are looking for. Used to match against file paths, filenames, and code identifiers.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory to search in. Defaults to the current working directory.',
    ),
  file_types: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of file extensions to restrict the search (e.g. [".ts", ".js"]). If omitted, all text files are considered.',
    ),
  max_results: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Maximum number of results to return. Defaults to 20. Capped at 50.',
    ),
});

export type SearchWorkspaceInput = z.Infer<typeof SearchWorkspaceInputSchema>;

/** Maximum files returned in the tree output. */
const DEFAULT_MAX_RESULTS = 20;
const HARD_MAX_RESULTS = 50;

/** Token budget for the combined output (~2000 chars). */
const OUTPUT_CHAR_BUDGET = 2000;

/** Skip files larger than this for identifier extraction. */
const MAX_FILE_SIZE_BYTES = 100 * 1024;

/** Skip lines longer than this when extracting identifiers. */
const MAX_LINE_LENGTH = 5000;

/** Recency boost: files modified within this window get a multiplier. */
const RECENT_MTIME_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_MTIME_BOOST = 2;

/** Scoring weights */
const PATH_MATCH_WEIGHT = 3;
const IDENTIFIER_MATCH_WEIGHT = 5;

// POSIX mode bits — same constants used by KaosPath.isDir (packages/kaos/src/path.ts:199).
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

// Identifiers: class/function/const/let/var/export names
// Matches: export function name, export class name, export const/let/var name,
// function name, class name, type/interface name
const IDENTIFIER_RE =
  /(?:export\s+)?(?:(?:async\s+)?function|class|const|let|var|type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

// Safe regex for matching intent keywords against text (no user regex injection)
function buildKeywordPatterns(intent: string): RegExp[] {
  const words = intent
    .toLowerCase()
    .split(/[^a-z0-9_$]+/u)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  return words.map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

/**
 * File fingerprint for cache key generation.
 */
interface FileFingerprint {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Cached identifier extraction result.
 */
interface IdentifierCacheEntry {
  readonly fingerprint: FileFingerprint;
  readonly identifiers: readonly string[];
}

/**
 * A scored candidate in the search results.
 */
interface SearchResult {
  readonly filePath: string;
  readonly score: number;
  readonly identifiers: readonly string[];
}

export class SearchWorkspaceTool implements BuiltinTool<SearchWorkspaceInput> {
  readonly name = 'SearchWorkspace' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SearchWorkspaceInputSchema);
  private readonly _validateArgs = createAjvValidateArgs(this.parameters);
  private readonly identifierCache = new Map<string, IdentifierCacheEntry>();
  validateArgs(args: unknown) {
    return this._validateArgs(args);
  }

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {
    this.description = SEARCH_WORKSPACE_DESCRIPTION;
  }

  resolveExecution(args: SearchWorkspaceInput): ToolExecution {
    let searchRoot: string;
    if (args.path !== undefined) {
      searchRoot = resolvePathAccessPath(args.path, {
        kaos: this.kaos,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    } else {
      searchRoot = this.workspace.workspaceDir;
    }

    return {
      accesses: ToolAccesses.searchTree(searchRoot),
      description: `Searching workspace for: ${args.intent}`,
      display: {
        kind: 'file_io',
        operation: 'glob',
        path: searchRoot,
        detail: `intent: ${args.intent}`,
      },
      approvalRule: literalRulePattern(this.name, args.intent),
      execute: () => this.execution(args, searchRoot),
    };
  }

  private async execution(
    args: SearchWorkspaceInput,
    searchRoot: string,
  ): Promise<ExecutableToolResult> {
    const intent = args.intent;
    const maxResults = Math.min(args.max_results ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
    const fileTypes = args.file_types;
    const now = Date.now();

    const patterns = buildKeywordPatterns(intent);
    if (patterns.length === 0) {
      return { output: 'No searchable keywords found in intent.' };
    }

    // Build glob pattern based on file_types
    const globPattern = fileTypes && fileTypes.length > 0 ? `**/*` : `**/*`;

    // Collect all files from the workspace
    const seen = new Set<string>();
    const YIELD_SAFETY_CAP = 5000;
    let yielded = 0;

    const candidates: Array<SearchResult & { mtimeMs: number; size: number }> = [];

    try {
      for await (const filePath of this.kaos.glob(searchRoot, globPattern)) {
        yielded++;
        if (yielded >= YIELD_SAFETY_CAP) break;
        if (seen.has(filePath)) continue;
        seen.add(filePath);

        // Apply file_types filter
        if (fileTypes && fileTypes.length > 0) {
          const ext = getExtension(filePath);
          if (!fileTypes.includes(ext)) continue;
        }

        // Skip directories
        let size = 0;
        let mtimeMs = 0;
        let isDir = false;
        try {
          const st = await this.kaos.stat(filePath);
          mtimeMs = st.stMtime ?? 0;
          size = st.stSize ?? 0;
          isDir = (st.stMode & S_IFMT) === S_IFDIR;
        } catch {
          // stat failure — skip this file
          continue;
        }
        if (isDir) continue;

        // Score path/filename against intent keywords
        let score = 0;
        const relativePath = relativize(filePath, searchRoot);
        const filename = relativePath.split('/').pop() ?? relativePath;

        for (const pat of patterns) {
          if (pat.test(relativePath)) score += PATH_MATCH_WEIGHT;
          if (pat.test(filename)) score += PATH_MATCH_WEIGHT;
        }

        // Recency boost
        if (now - mtimeMs < RECENT_MTIME_WINDOW_MS) {
          score *= RECENT_MTIME_BOOST;
        }

        // Extract identifiers from text files (guarded by size + line length)
        const identifiers = await this.extractIdentifiers(filePath, size);
        for (const ident of identifiers) {
          for (const pat of patterns) {
            if (pat.test(ident)) {
              score += IDENTIFIER_MATCH_WEIGHT;
              break;
            }
          }
        }

        if (score === 0) continue;
        candidates.push({ filePath, mtimeMs, size, score, identifiers });
      }
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    // Sort by score descending, then by mtime descending
    candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);

    const results = candidates.slice(0, maxResults);

    if (results.length === 0) {
      return { output: `No files found matching intent: ${intent}` };
    }

    // Build tree output bounded by character budget
    const output = this.buildTreeOutput(results, searchRoot);

    const truncated = candidates.length > maxResults;
    const messages: string[] = [];
    if (truncated) {
      messages.push(
        `[${String(candidates.length)} total matches, showing top ${String(maxResults)}. Refine your intent for more specific results.]`,
      );
    }

    const combined = messages.length > 0 ? `${output}\n${messages.join('\n')}` : output;
    return { output: combined };
  }

  /**
   * Extract identifiers from a text file, with guards for size, line length,
   * and binary content detection.
   */
  private async extractIdentifiers(
    filePath: string,
    size: number,
  ): Promise<readonly string[]> {
    // Size guard: skip large files
    if (size > MAX_FILE_SIZE_BYTES) return [];

    // Cache check using {path, size, mtimeMs} fingerprint
    let mtimeMs = 0;
    try {
      const st = await this.kaos.stat(filePath);
      mtimeMs = st.stMtime ?? 0;
    } catch {
      return [];
    }

    const fingerprint: FileFingerprint = { path: filePath, size, mtimeMs };
    const cached = this.identifierCache.get(filePath);
    if (
      cached !== undefined &&
      cached.fingerprint.size === fingerprint.size &&
      cached.fingerprint.mtimeMs === fingerprint.mtimeMs
    ) {
      return cached.identifiers;
    }

    // Read file contents
    let text: string;
    try {
      const bytes = await this.kaos.readBytes(filePath);
      // Binary detection: check for null bytes in first 8KB
      const sample = bytes.subarray(0, 8192);
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) return [];
      }
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return [];
    }

    // Extract identifiers
    const identifiers: string[] = [];
    const seen = new Set<string>();
    const lines = text.split('\n');
    for (const line of lines) {
      // Line length guard
      if (line.length > MAX_LINE_LENGTH) continue;
      let match: RegExpExecArray | null;
      IDENTIFIER_RE.lastIndex = 0;
      while ((match = IDENTIFIER_RE.exec(line)) !== null) {
        const name = match[1];
        if (name !== undefined && !seen.has(name)) {
          seen.add(name);
          identifiers.push(name);
        }
      }
    }

    // Cache the result
    this.identifierCache.set(filePath, { fingerprint, identifiers });
    return identifiers;
  }

  /**
   * Build a compact tree output bounded by OUTPUT_CHAR_BUDGET.
   */
  private buildTreeOutput(
    results: readonly SearchResult[],
    searchRoot: string,
  ): string {
    const lines: string[] = [];
    let totalChars = 0;

    for (const result of results) {
      const relativePath = relativize(result.filePath, searchRoot);
      const matchingIdents = result.identifiers.filter((id) => id.length > 0);
      const tag =
        matchingIdents.length > 0
          ? ` [${matchingIdents.slice(0, 5).join(', ')}${matchingIdents.length > 5 ? ', ...' : ''}]`
          : '';
      const line = `├── ${relativePath}${tag}`;

      if (totalChars + line.length + 1 > OUTPUT_CHAR_BUDGET) {
        lines.push('└── ...');
        break;
      }
      lines.push(line);
      totalChars += line.length + 1;
    }

    return lines.join('\n');
  }
}

function relativize(filePath: string, base: string): string {
  const normalizedBase = base.endsWith('/') ? base : base + '/';
  if (filePath.startsWith(normalizedBase)) {
    return filePath.slice(normalizedBase.length);
  }
  return filePath;
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) return '';
  return filePath.slice(lastDot);
}
