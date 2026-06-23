/**
 * Deterministic intent-based tool router that replaces {@link CodeIndexShadowResolver}.
 *
 * At `resolve` time the router captures the builtin, MCP code-index, and native
 * fallback tools. At `resolveExecution` time it inspects the arguments and
 * routes to the optimal backend (code-index or native) using a 9-row decision
 * table evaluated top-to-bottom. On code-index failure it trips an
 * {@link ActiveCircuitBreaker}, invalidates the {@link IndexStateCache}, and
 * falls back to native execution.
 */

import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import type { ToolResolver, ToolResolverContext } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHADOW_BUILTIN_NAMES = new Set(['Grep', 'Glob']);
const FAILURE_THRESHOLD = 3;
const INDEX_STATE_TTL_MS = 5_000;
const SMALL_REPO_THRESHOLD = 50;
const PROBE_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Conservative regex heuristics
// ---------------------------------------------------------------------------

/** Patterns that are *only* expressible as regular expressions. */
const REGEX_ONLY_PATTERNS: readonly RegExp[] = [
  /\(\?:/,           // non-capturing group
  /\(\?=|\(\?!/,     // lookahead
  /\(\?<=|\(\?<!/,   // lookbehind
  /\(\?P</,          // Python named group
  /\\[dDwWsSbB]/,    // character class shortcuts (not escaped)
  /\{[0-9]+,[0-9]+\}/, // quantifier {n,m}
  /\{[0-9]+,\}/,     // quantifier {n,}
  /\[[^\]]*\\/,      // character class with escape
  /\(\?[imsx]*:/,    // inline flags
];

/** Patterns that are unambiguously literal text, even if they contain
 *  metacharacter-like characters. */
const LITERAL_SAFE_PATTERNS: readonly RegExp[] = [
  /^\$\w+$/,          // jQuery selector or shell var: $app, $HOME
  /^#\w+$/,           // CSS ID selector: #app
  /^\w+\.\w+$/,       // dotted identifier: user.name
  /^\$\([^)]*\)$/,    // shell subshell: $(cmd)
  /\\\$/,             // escaped dollar: \$
  /\\\{/,             // escaped brace: \{
  /\\\^/,             // escaped caret: \^
];

/**
 * Returns `true` when the search pattern contains unambiguous regex-only
 * structures that code-index cannot express.
 */
function isComplexRegex(pattern: string): boolean {
  if (LITERAL_SAFE_PATTERNS.some(p => p.test(pattern))) return false;
  if (REGEX_ONLY_PATTERNS.some(p => p.test(pattern))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Non-code domain classification
// ---------------------------------------------------------------------------

const DEFAULT_NON_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.textile',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.xml', '.csv', '.tsv', '.env',
  '.log', '.out',
  '.lock',
  '.svg', '.graphql', '.gql',
]);

/**
 * Returns `true` when `filePattern` ends with a known non-code file extension.
 */
function isNonCodeFilePattern(filePattern: unknown, nonCodeExts: ReadonlySet<string>): boolean {
  if (typeof filePattern !== 'string') return false;
  const ext = filePattern.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase();
  if (ext === undefined) return false;
  return nonCodeExts.has(ext);
}

// ---------------------------------------------------------------------------
// Context lines guard
// ---------------------------------------------------------------------------

/** Returns `true` when any explicit context-line flag is present as a number. */
function hasExplicitContext(args: Record<string, unknown>): boolean {
  return typeof args['-A'] === 'number'
    || typeof args['-B'] === 'number'
    || typeof args['-C'] === 'number';
}

// ---------------------------------------------------------------------------
// IndexStateCache (singleflight dedup)
// ---------------------------------------------------------------------------

interface IndexState {
  healthy: boolean;
  stale: boolean;
  pendingEventCount: number;
  fileCount: number;
}

class IndexStateCache {
  private cached: IndexState | undefined;
  private cachedAt = 0;
  private inflight: Promise<IndexState> | undefined;

  async get(fetcher: () => Promise<IndexState>): Promise<IndexState> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cachedAt < INDEX_STATE_TTL_MS) {
      return this.cached;
    }
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    this.inflight = fetcher();
    try {
      this.cached = await this.inflight;
      this.cachedAt = Date.now();
      return this.cached;
    } finally {
      this.inflight = undefined;
    }
  }

  invalidate(): void {
    this.cached = undefined;
    this.cachedAt = 0;
  }
}

// ---------------------------------------------------------------------------
// ActiveCircuitBreaker (probe-based, NOT time-based)
// ---------------------------------------------------------------------------

class ActiveCircuitBreaker {
  private state: 'closed' | 'open' | 'probing' = 'closed';
  private failures = 0;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;

  isOpen(): boolean {
    return this.state === 'open' || this.state === 'probing';
  }

  recordFailure(probe: () => void): void {
    this.failures += 1;
    if (this.failures >= FAILURE_THRESHOLD) {
      this.state = 'open';
      this.scheduleProbe(probe);
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  async probe(healthCheck: () => Promise<boolean>): Promise<void> {
    if (this.state !== 'open') return;
    this.state = 'probing';
    try {
      const healthy = await healthCheck();
      this.state = healthy ? 'closed' : 'open';
      if (healthy) this.failures = 0;
    } catch {
      this.state = 'open';
    }
  }

  private scheduleProbe(probe: () => void): void {
    if (this.probeTimer !== undefined) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      probe();
    }, PROBE_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

interface NormalizedLine {
  filePath: string;
  lineNumber: number;
  text: string;
}

/** Parse a JSON string, returning the original value on failure. */
function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * Parse code-index JSON output (`{results: [{file, line, text}], ...}`) into
 * normalised line records. Line numbers are already 1-based from ripgrep.
 */
function parseCodeIndexResults(json: unknown): NormalizedLine[] {
  if (typeof json !== 'object' || json === null) return [];
  const obj = json as Record<string, unknown>;
  const results = Array.isArray(obj['results']) ? obj['results'] : [];
  return results.map((r: unknown) => {
    const rec = r as Record<string, unknown>;
    return {
      filePath: typeof rec['file'] === 'string' ? rec['file'] : '',
      lineNumber: Number(rec['line'] ?? 0),
      text: typeof rec['text'] === 'string' ? rec['text'] : '',
    };
  });
}

/**
 * Parse native grep text output (`path:line:text`) into normalised line
 * records.  Lines that do not contain at least two colon-separated fields
 * with a numeric line number are silently skipped so that non-grep output
 * (e.g. test fixtures returning plain strings) passes through unchanged.
 */
function parseNativeGrepOutput(text: string): NormalizedLine[] {
  if (!text) return [];
  const lines = text.split('\n').filter(l => l.length > 0);
  const result: NormalizedLine[] = [];
  for (const line of lines) {
    const firstColon = line.indexOf(':');
    if (firstColon === -1) continue;
    const filePath = line.substring(0, firstColon);
    const rest = line.substring(firstColon + 1);
    const secondColon = rest.indexOf(':');
    if (secondColon === -1) continue;
    const lineNum = parseInt(rest.substring(0, secondColon), 10);
    if (isNaN(lineNum) || lineNum < 0) continue;
    result.push({ filePath, lineNumber: lineNum, text: rest.substring(secondColon + 1) });
  }
  return result;
}

/**
 * Format normalised lines into the native Grep text representation for the
 * given output mode (`content`, `files_with_matches`, or `count_matches`).
 */
function formatAsNativeGrep(lines: NormalizedLine[], mode: string): string {
  if (mode === 'files_with_matches') {
    const files = [...new Set(lines.map(l => l.filePath))];
    return files.join('\n');
  }
  if (mode === 'count_matches') {
    const counts = new Map<string, number>();
    for (const l of lines) {
      counts.set(l.filePath, (counts.get(l.filePath) ?? 0) + 1);
    }
    return [...counts.entries()].map(([f, c]) => `${f}:${c}`).join('\n');
  }
  // content mode
  return lines.map(l => `${l.filePath}:${l.lineNumber}:${l.text}`).join('\n');
}

/**
 * Sort lines by file path then line number and truncate to `limit`.
 */
function sortAndTruncate(lines: NormalizedLine[], limit: number): NormalizedLine[] {
  const sorted = [...lines].toSorted((a, b) => {
    const pathCmp = a.filePath.localeCompare(b.filePath);
    return pathCmp !== 0 ? pathCmp : a.lineNumber - b.lineNumber;
  });
  return sorted.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Argument mapping (Grep → search_code_advanced, Glob → find_files)
// ---------------------------------------------------------------------------

function mapGrepToSearchCodeAdvanced(args: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    pattern: args['pattern'],
    regex: true,
  };
  if (args['-i'] === true) {
    mapped['case_sensitive'] = false;
  }
  if (typeof args['head_limit'] === 'number') {
    mapped['max_results'] = args['head_limit'];
  }
  if (typeof args['offset'] === 'number') {
    mapped['start_index'] = args['offset'];
  }
  if (typeof args['glob'] === 'string') {
    mapped['file_pattern'] = args['glob'];
  } else if (typeof args['type'] === 'string') {
    mapped['file_pattern'] = `*.${args['type']}`;
  }
  return mapped;
}

function mapGlobToFindFiles(args: Record<string, unknown>): Record<string, unknown> {
  return { pattern: args['pattern'] };
}

/** Strip code-index-only fields before forwarding to native. */
function prepareNativeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const nativeArgs = { ...args };
  delete nativeArgs['fuzzy']; // silent downgrade: native cannot do fuzzy
  return nativeArgs;
}

// ---------------------------------------------------------------------------
// IntentRouter
// ---------------------------------------------------------------------------

export class IntentRouter implements ToolResolver {
  readonly name = 'intent-router';
  private readonly breaker = new ActiveCircuitBreaker();
  private readonly indexCache = new IndexStateCache();

  // -- ToolResolver interface -------------------------------------------------

  resolve(name: string, context: ToolResolverContext): ExecutableTool | undefined {
    if (!SHADOW_BUILTIN_NAMES.has(name)) return undefined;
    const tools = this.findCodeIndexTools(context);
    if (tools === undefined) return undefined;
    return this.createRoutingTool(name, tools, context);
  }

  // -- MCP tool discovery -----------------------------------------------------

  private findCodeIndexTools(
    context: ToolResolverContext,
  ): { search: ExecutableTool; find: ExecutableTool } | undefined {
    const search = this.findMcpTool(context, 'search_code_advanced');
    const find = this.findMcpTool(context, 'find_files');
    if (search === undefined || find === undefined) return undefined;
    return { search, find };
  }

  private findMcpTool(context: ToolResolverContext, unqualified: string): ExecutableTool | undefined {
    const suffix = `__${unqualified}`;
    for (const { name, tool } of context.listMcp()) {
      if (name.endsWith(suffix) && context.isMcpEnabled(name)) return tool;
    }
    return undefined;
  }

  // -- Index state fetching ---------------------------------------------------

  private async fetchIndexState(context: ToolResolverContext): Promise<IndexState> {
    const watcherTool = this.findMcpTool(context, 'get_file_watcher_status');
    if (watcherTool === undefined) {
      return { healthy: false, stale: true, pendingEventCount: -1, fileCount: -1 };
    }
    try {
      const exec = await watcherTool.resolveExecution({});
      if ('isError' in exec && exec.isError === true) {
        return { healthy: false, stale: true, pendingEventCount: -1, fileCount: -1 };
      }
      // Tool resolved successfully — assume healthy index for routing decisions.
      // fileCount = -1 means "unknown" — do not trigger Row 7 (small repo).
      return { healthy: true, stale: false, pendingEventCount: 0, fileCount: -1 };
    } catch {
      return { healthy: false, stale: true, pendingEventCount: -1, fileCount: -1 };
    }
  }

  // -- Routing decision table -------------------------------------------------

  private routeDecision(
    args: Record<string, unknown>,
    builtinName: string,
    indexState: IndexState,
    _context: ToolResolverContext,
  ): 'native' | 'code-index' {
    // Row 1: Circuit breaker is open
    if (this.breaker.isOpen()) return 'native';

    // Row 2: Non-code file pattern
    const filePattern = builtinName === 'Grep'
      ? (args['glob'] as string | undefined)
      : (args['pattern'] as string | undefined);
    if (isNonCodeFilePattern(filePattern, DEFAULT_NON_CODE_EXTENSIONS)) return 'native';

    // Row 3: Complex regex (Grep only)
    if (builtinName === 'Grep' && isComplexRegex(typeof args['pattern'] === 'string' ? args['pattern'] : '')) return 'native';

    // Row 4: Explicit context flags (Grep only)
    if (builtinName === 'Grep' && hasExplicitContext(args)) return 'native';

    // Row 5: Multiline (Grep only)
    if (builtinName === 'Grep' && args['multiline'] === true) return 'native';

    // Row 6: Index is stale
    if (indexState.stale) return 'native';

    // Row 7: Repo scale < 50 files
    const fileCount = indexState.fileCount;
    if (fileCount >= 0 && fileCount < SMALL_REPO_THRESHOLD) return 'native';

    // Row 8: Fuzzy
    if (args['fuzzy'] === true) return 'code-index';

    // Row 9: Default
    return 'code-index';
  }

  // -- Tool creation ----------------------------------------------------------

  private createRoutingTool(
    builtinName: string,
    tools: { search: ExecutableTool; find: ExecutableTool },
    context: ToolResolverContext,
  ): ExecutableTool {
    const fallback = context.getBuiltin(builtinName);
    const inner = builtinName === 'Grep' ? tools.search : tools.find;
    const mapArgs = builtinName === 'Grep' ? mapGrepToSearchCodeAdvanced : mapGlobToFindFiles;

    return {
      name: builtinName,
      description: fallback?.description ?? inner.description,
      parameters: fallback?.parameters ?? inner.parameters,
      annotations: inner.annotations,
      resolveExecution: async (args: Record<string, unknown>): Promise<ToolExecution> => {
        const indexState = await this.indexCache.get(() => this.fetchIndexState(context));
        const decision = this.routeDecision(args, builtinName, indexState, context);

        if (decision === 'native') {
          return this.executeNative(builtinName, args, fallback, inner, context);
        }
        return this.executeCodeIndex(builtinName, args, mapArgs, inner, fallback, context);
      },
    };
  }

  // -- Execution strategies ---------------------------------------------------

  private async executeNative(
    builtinName: string,
    args: Record<string, unknown>,
    fallback: ExecutableTool | undefined,
    inner: ExecutableTool,
    _context: ToolResolverContext,
  ): Promise<ToolExecution> {
    if (fallback === undefined) {
      // No native fallback available — use code-index tool with original args.
      return inner.resolveExecution(args);
    }
    const nativeExecution = await fallback.resolveExecution(prepareNativeArgs(args));
    if ('isError' in nativeExecution && nativeExecution.isError === true) {
      return nativeExecution;
    }

    const runnable = nativeExecution;
    const outputMode = typeof args['output_mode'] === 'string' ? args['output_mode'] : 'content';
    const headLimit = typeof args['head_limit'] === 'number' ? args['head_limit'] : 250;

    return {
      ...runnable,
      execute: async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
        const result = await runnable.execute(ctx);
        if (result.isError === true) return result;

        // UnifiedSortPass: parse native output, sort, truncate, re-format
        const text = typeof result.output === 'string' ? result.output : '';
        const parsed = parseNativeGrepOutput(text);
        if (parsed.length === 0) return result;

        const sorted = sortAndTruncate(parsed, headLimit);
        const normalized = formatAsNativeGrep(sorted, outputMode);

        const truncated = parsed.length > headLimit
          ? `\nResults truncated to ${headLimit} lines (total: ${parsed.length}). Use offset=${headLimit} to see more.`
          : '';

        return { output: normalized + truncated };
      },
    };
  }

  private async executeCodeIndex(
    builtinName: string,
    args: Record<string, unknown>,
    mapArgs: (args: Record<string, unknown>) => Record<string, unknown>,
    inner: ExecutableTool,
    fallback: ExecutableTool | undefined,
    _context: ToolResolverContext,
  ): Promise<ToolExecution> {
    const mapped = mapArgs(args);
    const innerExecution = await inner.resolveExecution(mapped);
    if ('isError' in innerExecution && innerExecution.isError === true) {
      this.breaker.recordFailure(() => {
        this.indexCache.invalidate();
      });
      // Fallback to native
      if (fallback !== undefined) {
        return fallback.resolveExecution(prepareNativeArgs(args));
      }
      return innerExecution;
    }

    const runnable = innerExecution;
    return {
      accesses: runnable.accesses,
      description: runnable.description ?? `code-index ${builtinName}`,
      display: runnable.display,
      approvalRule: builtinName,
      matchesRule: (ruleArgs) => ruleArgs === builtinName,
      execute: async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
        const result = await runnable.execute(ctx);
        if (result.isError === true) {
          this.breaker.recordFailure(() => {
            this.indexCache.invalidate();
          });
          // Fallback to native execution
          if (fallback !== undefined) {
            const fbExec = await fallback.resolveExecution(prepareNativeArgs(args));
            if (!('isError' in fbExec && fbExec.isError === true)) {
              return fbExec.execute(ctx);
            }
          }
          return result;
        }

        this.breaker.recordSuccess();

        // Normalize code-index JSON output to native Grep format
        const outputMode = typeof args['output_mode'] === 'string' ? args['output_mode'] : 'content';
        const headLimit = typeof args['head_limit'] === 'number' ? args['head_limit'] : 250;
        const parsed = typeof result.output === 'string' ? tryParseJson(result.output) : result.output;
        const normalizedLines = parseCodeIndexResults(parsed);
        const sorted = sortAndTruncate(normalizedLines, headLimit);
        const normalized = formatAsNativeGrep(sorted, outputMode);

        const truncated = normalizedLines.length > headLimit
          ? `\nResults truncated to ${headLimit} lines (total: ${normalizedLines.length}). Use offset=${headLimit} to see more.`
          : '';

        return { output: normalized + truncated };
      },
    };
  }
}
