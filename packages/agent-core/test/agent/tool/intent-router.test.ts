import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ExecutableTool, ExecutableToolResult, ToolExecution } from '../../../src/loop/types';
import type { ToolResolverContext } from '../../../src/agent/tool/resolvers/types';
import { IntentRouter } from '../../../src/agent/tool/resolvers/intent-router';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, overrides?: Partial<ExecutableTool>): ExecutableTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object' },
    resolveExecution: async () => ({
      approvalRule: name,
      execute: async () => ({ output: name }),
    }),
    ...overrides,
  };
}

function makeCodeIndexSearchResult(results: Array<{ file: string; line: number; text: string }>) {
  return {
    results,
    pagination: {
      total_matches: results.length,
      returned: results.length,
      start_index: 0,
      has_more: false,
      max_results: 10,
      end_index: results.length,
    },
  };
}

function makeContext(partial: Partial<ToolResolverContext> = {}): ToolResolverContext {
  return {
    getBuiltin: () => undefined,
    getUser: () => undefined,
    getMcp: () => undefined,
    listMcp: () => [],
    isMcpEnabled: () => false,
    ...partial,
  };
}

function makeMcpTools(overrides?: Partial<ToolResolverContext>): ToolResolverContext {
  const searchTool = makeTool('mcp__code-index__search_code_advanced');
  const findTool = makeTool('mcp__code-index__find_files');
  const watcherTool = makeTool('mcp__code-index__get_file_watcher_status');
  return makeContext({
    getBuiltin: (name) => makeTool(name),
    listMcp: () => [
      { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
      { name: 'mcp__code-index__find_files', tool: findTool },
      { name: 'mcp__code-index__get_file_watcher_status', tool: watcherTool },
    ],
    isMcpEnabled: (name) => name.startsWith('mcp__code-index__'),
    ...overrides,
  });
}

async function executeTool(tool: ExecutableTool, args: Record<string, unknown> = {}): Promise<ExecutableToolResult> {
  const execution = await tool.resolveExecution(args);
  if ('isError' in execution && execution.isError === true) {
    return { output: execution.output, isError: true };
  }
  const runnable = execution as { execute: (ctx: never) => Promise<ExecutableToolResult> };
  return runnable.execute({} as never);
}

// ---------------------------------------------------------------------------
// IntentRouter.resolve()
// ---------------------------------------------------------------------------

describe('IntentRouter', () => {
  let router: IntentRouter;

  beforeEach(() => {
    router = new IntentRouter();
  });

  describe('resolve()', () => {
    it('returns undefined for non-Grep/Glob names', () => {
      const context = makeMcpTools();
      expect(router.resolve('Read', context)).toBeUndefined();
      expect(router.resolve('Write', context)).toBeUndefined();
      expect(router.resolve('Bash', context)).toBeUndefined();
    });

    it('returns undefined when code-index tools are not available', () => {
      const context = makeContext();
      expect(router.resolve('Grep', context)).toBeUndefined();
      expect(router.resolve('Glob', context)).toBeUndefined();
    });

    it('returns a shadow tool for Grep when code-index is available', () => {
      const context = makeMcpTools();
      const tool = router.resolve('Grep', context);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('Grep');
    });

    it('returns a shadow tool for Glob when code-index is available', () => {
      const context = makeMcpTools();
      const tool = router.resolve('Glob', context);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('Glob');
    });

    it('preserves builtin description and parameters', () => {
      const builtin = makeTool('Grep', {
        description: 'Search for patterns',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
      });
      const context = makeMcpTools({
        getBuiltin: (name) => (name === 'Grep' ? builtin : undefined),
      });
      const tool = router.resolve('Grep', context);
      expect(tool!.description).toBe('Search for patterns');
      expect(tool!.parameters).toEqual({ type: 'object', properties: { pattern: { type: 'string' } } });
    });

    it('propagates MCP tool annotations', () => {
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        annotations: { readOnlyHint: true },
      });
      const context = makeContext({
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
        ],
        isMcpEnabled: () => true,
      });
      const tool = router.resolve('Grep', context);
      expect(tool!.annotations).toEqual({ readOnlyHint: true });
    });
  });

  // -------------------------------------------------------------------------
  // Routing decision table
  // -------------------------------------------------------------------------

  describe('routing decisions', () => {
    it('Row 1: routes to native when circuit breaker is open', async () => {
      // Trip the breaker by causing 3 failures
      const failSearchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => ({
          isError: true as const,
          output: 'error',
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: failSearchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
        ],
        isMcpEnabled: () => true,
      });

      // Trip the breaker with 3 consecutive failures
      for (let i = 0; i < 3; i++) {
        const tool = router.resolve('Grep', context)!;
        const exec = await tool.resolveExecution({ pattern: 'test' });
        if ('execute' in exec) {
          await exec.execute({} as never);
        }
      }

      // Now the breaker should be open — next call should route to native
      const nativeCalled = { value: false };
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => {
          nativeCalled.value = true;
          return {
            approvalRule: 'Grep',
            execute: async () => ({ output: 'native result' }),
          };
        },
      });
      const contextWithNative = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: makeTool('mcp__code-index__search_code_advanced') },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
        ],
        isMcpEnabled: () => true,
      });

      // Create a new router to test with the tripped breaker state
      // Since breaker is internal, we test through the full flow
      const tool2 = router.resolve('Grep', contextWithNative)!;
      const exec2 = await tool2.resolveExecution({ pattern: 'test' });
      if ('execute' in exec2) {
        const result = await exec2.execute({} as never);
        // Should have gotten native result since breaker is open
        expect(result.output).toBe('native result');
        expect(nativeCalled.value).toBe(true);
      }
    });

    it('Row 2: routes to native for non-code file patterns', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'test', glob: '*.json' });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });

    it('Row 3: routes to native for complex regex patterns', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      // Non-capturing group is unambiguously regex
      const exec = await tool.resolveExecution({ pattern: '(?:foo|bar)' });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });

    it('Row 4: routes to native when context flags are present', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'test', '-C': 3 });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });

    it('Row 5: routes to native for multiline=true', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'test', multiline: true });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });

    it('Row 8: routes to code-index for fuzzy=true', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({
              output: JSON.stringify(makeCodeIndexSearchResult([
                { file: 'src/foo.ts', line: 10, text: 'fuzzyMatch' },
              ])),
            }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'fuzzyMatch', fuzzy: true });
      if ('execute' in exec) {
        await exec.execute({} as never);
        expect(codeIndexCalled).toBe(true);
      }
    });

    it('Row 9: default routes to code-index for literal patterns', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({
              output: JSON.stringify(makeCodeIndexSearchResult([
                { file: 'src/foo.ts', line: 5, text: 'hello' },
              ])),
            }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'hello' });
      if ('execute' in exec) {
        await exec.execute({} as never);
        expect(codeIndexCalled).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Output normalization
  // -------------------------------------------------------------------------

  describe('output normalization', () => {
    it('normalizes code-index JSON to content mode format', async () => {
      const freshRouter = new IntentRouter();
      const codeIndexResult = makeCodeIndexSearchResult([
        { file: 'src/b.ts', line: 20, text: 'world' },
        { file: 'src/a.ts', line: 10, text: 'hello' },
      ]);
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => ({
          approvalRule: 'search',
          execute: async () => ({ output: JSON.stringify(codeIndexResult) }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = freshRouter.resolve('Grep', context)!;
      const result = await executeTool(tool, { pattern: 'hello' });

      // Should be sorted by (filePath, lineNumber)
      expect(result.output).toBe('src/a.ts:10:hello\nsrc/b.ts:20:world');
    });

    it('normalizes code-index JSON to files_with_matches mode format', async () => {
      const freshRouter = new IntentRouter();
      const codeIndexResult = makeCodeIndexSearchResult([
        { file: 'src/a.ts', line: 10, text: 'hello' },
        { file: 'src/a.ts', line: 20, text: 'hello again' },
        { file: 'src/b.ts', line: 5, text: 'hello' },
      ]);
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => ({
          approvalRule: 'search',
          execute: async () => ({ output: JSON.stringify(codeIndexResult) }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = freshRouter.resolve('Grep', context)!;
      const result = await executeTool(tool, { pattern: 'hello', output_mode: 'files_with_matches' });

      // Should deduplicate files
      expect(result.output).toBe('src/a.ts\nsrc/b.ts');
    });

    it('normalizes code-index JSON to count_matches mode format', async () => {
      const freshRouter = new IntentRouter();
      const codeIndexResult = makeCodeIndexSearchResult([
        { file: 'src/a.ts', line: 10, text: 'hello' },
        { file: 'src/a.ts', line: 20, text: 'hello again' },
        { file: 'src/b.ts', line: 5, text: 'hello' },
      ]);
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => ({
          approvalRule: 'search',
          execute: async () => ({ output: JSON.stringify(codeIndexResult) }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = freshRouter.resolve('Grep', context)!;
      const result = await executeTool(tool, { pattern: 'hello', output_mode: 'count_matches' });

      expect(result.output).toBe('src/a.ts:2\nsrc/b.ts:1');
    });

    it('appends truncation indicator when results exceed head_limit', async () => {
      const freshRouter = new IntentRouter();
      const results = Array.from({ length: 10 }, (_, i) => ({
        file: 'src/a.ts',
        line: i + 1,
        text: `line ${i + 1}`,
      }));
      const codeIndexResult = makeCodeIndexSearchResult(results);
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => ({
          approvalRule: 'search',
          execute: async () => ({ output: JSON.stringify(codeIndexResult) }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = freshRouter.resolve('Grep', context)!;
      const result = await executeTool(tool, { pattern: 'line', head_limit: 5 });

      const output = result.output as string;
      expect(output).toContain('Results truncated to 5 lines (total: 10)');
      expect(output).toContain('Use offset=5 to see more');
    });
  });

  // -------------------------------------------------------------------------
  // Argument mapping
  // -------------------------------------------------------------------------

  describe('argument mapping', () => {
    it('maps -i to case_sensitive=false', async () => {
      let mappedArgs: Record<string, unknown> = {};
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async (args) => {
          mappedArgs = args as Record<string, unknown>;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      await executeTool(tool, { pattern: 'test', '-i': true });

      expect(mappedArgs['case_sensitive']).toBe(false);
      expect(mappedArgs['regex']).toBe(true);
    });

    it('maps glob to file_pattern', async () => {
      let mappedArgs: Record<string, unknown> = {};
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async (args) => {
          mappedArgs = args as Record<string, unknown>;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      await executeTool(tool, { pattern: 'test', glob: '*.ts' });

      expect(mappedArgs['file_pattern']).toBe('*.ts');
    });

    it('strips fuzzy when routing to native (graceful degradation)', async () => {
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async (args) => {
          // Verify fuzzy is stripped
          expect((args as Record<string, unknown>)['fuzzy']).toBeUndefined();
          return {
            approvalRule: 'Grep',
            execute: async () => ({ output: 'native' }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: makeTool('mcp__code-index__search_code_advanced') },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      // We can't easily test the breaker-open + fuzzy case without tripping the breaker first.
      // Instead, test prepareNativeArgs indirectly through a context flag that forces native.
      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'test', fuzzy: true, '-C': 1 });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Fallback behavior
  // -------------------------------------------------------------------------

  describe('fallback', () => {
    it('falls back to native when code-index resolveExecution errors', async () => {
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => ({
          isError: true as const,
          output: 'code-index error',
        }),
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'fallback result' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'test' });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('fallback result');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pattern analysis edge cases
  // -------------------------------------------------------------------------

  describe('pattern analysis', () => {
    it('treats jQuery selectors as literal (not regex)', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      await executeTool(tool, { pattern: '$app' });
      expect(codeIndexCalled).toBe(true);
    });

    it('treats shell variables as literal', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      await executeTool(tool, { pattern: '$HOME' });
      expect(codeIndexCalled).toBe(true);
    });

    it('detects lookahead as complex regex', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      const exec = await tool.resolveExecution({ pattern: 'foo(?=bar)' });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });

    it('detects character class as complex regex', async () => {
      let codeIndexCalled = false;
      const searchTool = makeTool('mcp__code-index__search_code_advanced', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'search',
            execute: async () => ({ output: JSON.stringify(makeCodeIndexSearchResult([])) }),
          };
        },
      });
      const nativeBuiltin = makeTool('Grep', {
        resolveExecution: async () => ({
          approvalRule: 'Grep',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Grep' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
          { name: 'mcp__code-index__find_files', tool: makeTool('mcp__code-index__find_files') },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Grep', context)!;
      // \d is unambiguously regex
      const exec = await tool.resolveExecution({ pattern: '\\d+' });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Glob tool routing
  // -------------------------------------------------------------------------

  describe('Glob tool', () => {
    it('routes Glob to code-index by default', async () => {
      let codeIndexCalled = false;
      const findTool = makeTool('mcp__code-index__find_files', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'find',
            execute: async () => ({ output: 'src/foo.ts' }),
          };
        },
      });
      const context = makeContext({
        getBuiltin: (name) => makeTool(name),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: makeTool('mcp__code-index__search_code_advanced') },
          { name: 'mcp__code-index__find_files', tool: findTool },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Glob', context)!;
      await executeTool(tool, { pattern: '*.ts' });
      expect(codeIndexCalled).toBe(true);
    });

    it('routes Glob to native for non-code patterns', async () => {
      let codeIndexCalled = false;
      const findTool = makeTool('mcp__code-index__find_files', {
        resolveExecution: async () => {
          codeIndexCalled = true;
          return {
            approvalRule: 'find',
            execute: async () => ({ output: '' }),
          };
        },
      });
      const nativeBuiltin = makeTool('Glob', {
        resolveExecution: async () => ({
          approvalRule: 'Glob',
          execute: async () => ({ output: 'native' }),
        }),
      });
      const context = makeContext({
        getBuiltin: (name) => (name === 'Glob' ? nativeBuiltin : undefined),
        listMcp: () => [
          { name: 'mcp__code-index__search_code_advanced', tool: makeTool('mcp__code-index__search_code_advanced') },
          { name: 'mcp__code-index__find_files', tool: findTool },
          { name: 'mcp__code-index__get_file_watcher_status', tool: makeTool('mcp__code-index__get_file_watcher_status') },
        ],
        isMcpEnabled: () => true,
      });

      const tool = router.resolve('Glob', context)!;
      const exec = await tool.resolveExecution({ pattern: '*.json' });
      if ('execute' in exec) {
        const result = await exec.execute({} as never);
        expect(result.output).toBe('native');
        expect(codeIndexCalled).toBe(false);
      }
    });
  });
});
