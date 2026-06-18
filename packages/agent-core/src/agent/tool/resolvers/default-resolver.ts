import type { ExecutableTool } from '../../../loop/types';
import type { ToolResolver, ToolResolverContext } from './types';

/**
 * Fallback resolver that mirrors the historical tool lookup order:
 * user tools take precedence over MCP tools, which take precedence over builtins.
 */
export class DefaultToolResolver implements ToolResolver {
  readonly name = 'default';

  resolve(name: string, context: ToolResolverContext): ExecutableTool | undefined {
    return context.getUser(name) ?? context.getMcp(name) ?? context.getBuiltin(name);
  }
}
