import { describe, expect, it } from 'vitest';

import type { ExecutableTool } from '../../../src/loop/types';
import {
  CodeIndexShadowResolver,
  DefaultToolResolver,
  ToolResolverChain,
  type ToolResolverContext,
} from '../../../src/agent/tool/resolvers';

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

describe('ToolResolverChain', () => {
  it('returns the first resolved tool in order', () => {
    const userTool = makeTool('Read');
    const chain = new ToolResolverChain([
      new CodeIndexShadowResolver(),
      new DefaultToolResolver(),
    ]);
    const tool = chain.resolve(
      'Read',
      makeContext({ getUser: (name) => (name === 'Read' ? userTool : undefined) }),
    );
    expect(tool).toBe(userTool);
  });

  it('falls back to the default resolver when no shadow applies', () => {
    const builtin = makeTool('Grep');
    const chain = new ToolResolverChain([
      new CodeIndexShadowResolver(),
      new DefaultToolResolver(),
    ]);
    const tool = chain.resolve('Grep', makeContext({ getBuiltin: (name) => (name === 'Grep' ? builtin : undefined) }));
    expect(tool).toBe(builtin);
  });
});

describe('CodeIndexShadowResolver', () => {
  it('shadows Grep when code-index search_code_advanced is available', () => {
    const resolver = new CodeIndexShadowResolver();
    const builtin = makeTool('Grep');
    const searchTool = makeTool('mcp__code-index__search_code_advanced', {
      annotations: { readOnlyHint: true },
    });
    const findTool = makeTool('mcp__code-index__find_files');
    const context = makeContext({
      getBuiltin: (name) => (name === 'Grep' ? builtin : undefined),
      listMcp: () => [
        { name: 'mcp__code-index__search_code_advanced', tool: searchTool },
        { name: 'mcp__code-index__find_files', tool: findTool },
      ],
      isMcpEnabled: (name) => name.startsWith('mcp__code-index__'),
    });

    const tool = resolver.resolve('Grep', context);
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('Grep');
    expect(tool!.annotations).toEqual({ readOnlyHint: true });
  });

  it('does not shadow when code-index tools are missing', () => {
    const resolver = new CodeIndexShadowResolver();
    const builtin = makeTool('Grep');
    const context = makeContext({ getBuiltin: (name) => (name === 'Grep' ? builtin : undefined) });
    expect(resolver.resolve('Grep', context)).toBeUndefined();
  });
});
