/**
 * Graph query layer — transforms raw nif-extractor output into the
 * agent-facing contract format consumed by the MCP tools.
 *
 * Responsibilities:
 *  - Traverse the dependency graph from a set of seed symbols up to `depth`.
 *  - Deduplicate nodes and edges.
 *  - Produce compact {@link SymbolContract} descriptors for each symbol.
 */

import type {
  NifSymbolData,
  SymbolNode,
  DependencyEdge,
  SymbolContract,
  SymbolQueryResult,
  GraphSliceResult,
} from './types.js';

// ---------------------------------------------------------------------------
// querySymbol — single-symbol lookup
// ---------------------------------------------------------------------------

/**
 * Given the raw NIF data for a root symbol (plus its transitive deps), build
 * a {@link SymbolQueryResult}.
 */
export function buildSymbolQueryResult(
  root: NifSymbolData,
  allSymbols: NifSymbolData[],
): SymbolQueryResult {
  const node = nifToNode(root);
  const edges = buildEdges(root, allSymbols);
  const contract = nifToContract(root);

  return {
    symbol: node,
    dependencies: edges,
    contract,
    macroExpanded: root.macroExpansion,
  };
}

// ---------------------------------------------------------------------------
// graphSlice — multi-symbol subgraph
// ---------------------------------------------------------------------------

/**
 * Build a subgraph containing all symbols reachable from `seeds` within
 * `depth` hops.
 */
export function buildGraphSlice(
  seedFqns: string[],
  allSymbols: NifSymbolData[],
  depth: number,
): GraphSliceResult {
  const symbolMap = new Map<string, NifSymbolData>();
  for (const s of allSymbols) {
    symbolMap.set(s.fqn, s);
  }

  // BFS from seeds up to `depth` hops.
  const visited = new Set<string>();
  const queue: Array<{ fqn: string; remainingDepth: number }> = seedFqns.map((fqn) => ({
    fqn,
    remainingDepth: depth,
  }));

  while (queue.length > 0) {
    const { fqn, remainingDepth } = queue.shift()!;
    if (visited.has(fqn)) continue;
    visited.add(fqn);

    const symbol = symbolMap.get(fqn);
    if (symbol === undefined) continue;

    if (remainingDepth > 0) {
      for (const dep of symbol.deps) {
        if (!visited.has(dep.fqn)) {
          queue.push({ fqn: dep.fqn, remainingDepth: remainingDepth - 1 });
        }
      }
    }
  }

  const nodes: SymbolNode[] = [];
  const edges: DependencyEdge[] = [];
  const contracts: SymbolContract[] = [];

  for (const fqn of visited) {
    const symbol = symbolMap.get(fqn);
    if (symbol === undefined) continue;
    nodes.push(nifToNode(symbol));
    contracts.push(nifToContract(symbol));
    edges.push(...buildEdges(symbol, allSymbols));
  }

  // Deduplicate edges.
  const edgeKey = (e: DependencyEdge): string => `${e.from}->${e.to}:${e.kind}`;
  const seenEdges = new Set<string>();
  const deduped: DependencyEdge[] = [];
  for (const e of edges) {
    const key = edgeKey(e);
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      deduped.push(e);
    }
  }

  return { nodes, edges: deduped, contracts };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nifToNode(data: NifSymbolData): SymbolNode {
  return {
    fqn: data.fqn,
    kind: data.kind,
    file: data.file,
    line: data.startLine,
    endLine: data.endLine,
    signature: data.signature,
    doc: data.doc,
  };
}

function nifToContract(data: NifSymbolData): SymbolContract {
  return {
    fqn: data.fqn,
    params: data.params?.map((p) => ({
      name: p.name,
      type: p.typeName,
      required: !p.optional,
      description: p.description,
      defaultValue: p.defaultValue,
    })),
    returnType: data.returnType,
    effects: data.effects,
    errors: data.errors,
  };
}

function buildEdges(
  symbol: NifSymbolData,
  _allSymbols: NifSymbolData[],
): DependencyEdge[] {
  return symbol.deps.map((dep) => ({
    from: symbol.fqn,
    to: dep.fqn,
    kind: classifyEdgeKind(dep.kind),
  }));
}

function classifyEdgeKind(
  nifKind: string,
): 'calls' | 'imports' | 'extends' | 'implements' | 'type-ref' {
  const lower = nifKind.toLowerCase();
  if (lower === 'call' || lower === 'calls') return 'calls';
  if (lower === 'import' || lower === 'imports') return 'imports';
  if (lower === 'extends' || lower === 'inheritance') return 'extends';
  if (lower === 'implements' || lower === 'interface-impl') return 'implements';
  return 'type-ref';
}
