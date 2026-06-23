import type { ExecutableTool } from '../../../loop/types';
import type { ToolResolver, ToolResolverContext } from './types';

export * from './types';
export * from './default-resolver';
export * from './intent-router';

/**
 * Ordered chain of resolvers. The first resolver to return a tool wins; the
 * final default resolver is always present.
 */
export class ToolResolverChain implements ToolResolver {
  readonly name = 'chain';
  private readonly resolvers: readonly ToolResolver[];

  constructor(resolvers: readonly ToolResolver[]) {
    this.resolvers = resolvers;
  }

  resolve(name: string, context: ToolResolverContext): ExecutableTool | undefined {
    for (const resolver of this.resolvers) {
      const tool = resolver.resolve(name, context);
      if (tool !== undefined) return tool;
    }
    return undefined;
  }
}
