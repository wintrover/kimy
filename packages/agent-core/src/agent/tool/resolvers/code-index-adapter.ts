import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { ToolResolver, ToolResolverContext } from './types';

const SHADOW_BUILTIN_NAMES = new Set(['Grep', 'Glob']);

interface CodeIndexTools {
  readonly searchCodeAdvanced: ExecutableTool;
  readonly findFiles: ExecutableTool;
}

interface CircuitBreakerState {
  failures: number;
  lastFailureAt: number;
  open: boolean;
}

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;

function normalizeCodeIndexResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

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
  const contextLines = [args['-A'], args['-B'], args['-C']]
    .filter((v): v is number => typeof v === 'number')
    .reduce((max, v) => Math.max(max, v), 0);
  if (contextLines > 0) {
    mapped['context_lines'] = contextLines;
  }
  return mapped;
}

function mapGlobToFindFiles(args: Record<string, unknown>): Record<string, unknown> {
  return { pattern: args['pattern'] };
}

function runWithCircuitBreaker(
  breaker: CircuitBreakerState,
  fn: () => Promise<ExecutableToolResult>,
): Promise<ExecutableToolResult> {
  if (breaker.open) {
    if (Date.now() - breaker.lastFailureAt < COOLDOWN_MS) {
      return Promise.resolve({
        isError: true,
        output: 'code-index circuit breaker is open; falling back to builtin tool',
      });
    }
    breaker.open = false;
    breaker.failures = 0;
  }

  return fn().then((result) => {
    if (result.isError === true) {
      breaker.failures += 1;
      breaker.lastFailureAt = Date.now();
      if (breaker.failures >= FAILURE_THRESHOLD) {
        breaker.open = true;
      }
    } else {
      breaker.failures = 0;
    }
    return result;
  });
}

export class CodeIndexShadowResolver implements ToolResolver {
  readonly name = 'code-index-shadow';
  private readonly breaker: CircuitBreakerState = { failures: 0, lastFailureAt: 0, open: false };

  resolve(name: string, context: ToolResolverContext): ExecutableTool | undefined {
    if (!SHADOW_BUILTIN_NAMES.has(name)) return undefined;
    const tools = this.findCodeIndexTools(context);
    if (tools === undefined) return undefined;
    return this.createShadowTool(name, tools, context);
  }

  private findCodeIndexTools(context: ToolResolverContext): CodeIndexTools | undefined {
    const search = this.findMcpTool(context, 'search_code_advanced');
    const find = this.findMcpTool(context, 'find_files');
    if (search === undefined || find === undefined) return undefined;
    return { searchCodeAdvanced: search, findFiles: find };
  }

  private findMcpTool(context: ToolResolverContext, unqualified: string): ExecutableTool | undefined {
    const suffix = `__${unqualified}`;
    for (const { name, tool } of context.listMcp()) {
      if (name.endsWith(suffix) && context.isMcpEnabled(name)) {
        return tool;
      }
    }
    return undefined;
  }

  private createShadowTool(
    builtinName: string,
    tools: CodeIndexTools,
    context: ToolResolverContext,
  ): ExecutableTool {
    const fallback = context.getBuiltin(builtinName);
    const inner = builtinName === 'Grep' ? tools.searchCodeAdvanced : tools.findFiles;
    const mapArgs = builtinName === 'Grep' ? mapGrepToSearchCodeAdvanced : mapGlobToFindFiles;

    return {
      name: builtinName,
      description: fallback?.description ?? inner.description,
      parameters: fallback?.parameters ?? inner.parameters,
      annotations: inner.annotations,
      resolveExecution: async (args: Record<string, unknown>): Promise<ToolExecution> => {
        const innerExecution = await inner.resolveExecution(mapArgs(args));
        if ('isError' in innerExecution && innerExecution.isError === true) {
          return innerExecution;
        }
        const runnable = innerExecution as Extract<typeof innerExecution, { execute: unknown }>;

        let fallbackExecution: { execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult> } | undefined;
        if (fallback !== undefined) {
          const exec = await fallback.resolveExecution(args);
          if (!('isError' in exec && exec.isError === true)) {
            fallbackExecution = exec as Extract<typeof exec, { execute: unknown }>;
          }
        }

        return {
          accesses: runnable.accesses,
          description: runnable.description ?? `code-index ${builtinName}`,
          display: runnable.display,
          approvalRule: builtinName,
          matchesRule: (ruleArgs) => ruleArgs === builtinName,
          execute: async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
            const result = await runWithCircuitBreaker(this.breaker, () => runnable.execute(ctx));
            if (result.isError !== true) {
              return { output: normalizeCodeIndexResult(result.output) };
            }
            if (fallbackExecution !== undefined) {
              return fallbackExecution.execute(ctx);
            }
            return result;
          },
        };
      },
    };
  }
}
