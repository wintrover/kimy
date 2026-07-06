/**
 * Symbol graph types shared across the MCP server and nif-extractor client.
 *
 * These types define the contract between the NIF extraction layer (S4)
 * and the agent-facing MCP tools that inject symbol dependencies into
 * the context window.
 */

/**
 * A single symbol node in the dependency graph.
 *
 * `fqn` (fully-qualified name) is the stable identifier, e.g.
 * `"packages/agent-core/src/agent/Agent.runTurn"`.
 */
export interface SymbolNode {
  /** Fully-qualified name, e.g. "src/agent/Agent.runTurn". */
  fqn: string;
  /** Human-readable kind: function, class, method, interface, type, etc. */
  kind: string;
  /** Source file path relative to project root. */
  file: string;
  /** Start line (1-based). */
  line: number;
  /** End line (1-based). */
  endLine: number;
  /** Signature string, e.g. `async runTurn(input: TurnInput): Promise<TurnResult>`. */
  signature?: string;
  /** Docstring / JSDoc if present. */
  doc?: string;
}

/**
 * A directed edge: `from` depends on / calls / imports `to`.
 */
export interface DependencyEdge {
  /** Source symbol fqn. */
  from: string;
  /** Target symbol fqn. */
  to: string;
  /** Relationship kind: "calls", "imports", "extends", "implements", "type-ref". */
  kind: 'calls' | 'imports' | 'extends' | 'implements' | 'type-ref';
}

/**
 * A contract descriptor for a symbol — the information an agent needs
 * to understand the symbol's API without reading the full source.
 */
export interface SymbolContract {
  fqn: string;
  /** Input parameters. */
  params?: ParamDescriptor[];
  /** Return type (stringified). */
  returnType?: string;
  /** Side effects / pre-conditions / post-conditions as free-form text. */
  effects?: string[];
  /** Errors the symbol may throw. */
  errors?: string[];
}

/**
 * A single parameter in a contract.
 */
export interface ParamDescriptor {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: string;
}

/**
 * Result of a `symbol_query` tool call.
 */
export interface SymbolQueryResult {
  symbol: SymbolNode;
  dependencies: DependencyEdge[];
  contract: SymbolContract;
  /** Macro-expanded representation (e.g. after inlining macros). */
  macroExpanded?: string;
}

/**
 * Result of a `graph_slice` tool call.
 */
export interface GraphSliceResult {
  nodes: SymbolNode[];
  edges: DependencyEdge[];
  contracts: SymbolContract[];
}

/**
 * Raw output from the nif-extractor (S4) before transformation.
 * The MCP server transforms this into the agent-facing types above.
 */
export interface NifSymbolData {
  fqn: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  doc?: string;
  deps: Array<{
    fqn: string;
    kind: string;
  }>;
  params?: Array<{
    name: string;
    typeName: string;
    optional: boolean;
    description?: string;
    defaultValue?: string;
  }>;
  returnType?: string;
  effects?: string[];
  errors?: string[];
  macroExpansion?: string;
}
