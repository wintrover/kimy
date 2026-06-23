import type { ExecutableTool } from '../../../loop/types';

/**
 * Context passed to every resolver in the chain. It exposes a read-only view of
 * the tool registrations so resolvers can make decisions without mutating the
 * manager.
 */
export interface ToolResolverContext {
  /** Returns the currently active builtin tool with this exact name, if any. */
  getBuiltin(name: string): ExecutableTool | undefined;
  /** Returns the currently active user-registered tool with this name, if any. */
  getUser(name: string): ExecutableTool | undefined;
  /** Returns the currently active MCP tool with this qualified name, if any. */
  getMcp(name: string): ExecutableTool | undefined;
  /** Iterates over every active MCP tool. */
  listMcp(): Iterable<{ readonly name: string; readonly tool: ExecutableTool }>;
  /** Returns true when the qualified MCP tool name is exposed by the active profile. */
  isMcpEnabled(name: string): boolean;

  /** Returns cached workspace file count for scale-based routing. */
  getWorkspaceFileCount?(): number;

  /** Returns true when the MCP server connection for the given server is healthy. */
  isMcpServerHealthy?(serverName: string): boolean;

  /** Returns the FileDomainConfig built from env/config/defaults. */
  getFileDomainConfig?(): { nonCodeExtensions: Set<string> };
}

export interface ToolResolver {
  readonly name: string;
  resolve(name: string, context: ToolResolverContext): ExecutableTool | undefined;
}
