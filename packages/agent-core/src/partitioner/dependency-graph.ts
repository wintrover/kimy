/**
 * dependency-graph — undirected dependency graph construction from import data.
 *
 * Builds an undirected edge set from per-file import relationships,
 * deduplicates edges using sorted-pair keys, and computes per-node
 * I/O degrees for the cost model.
 */

import type { FileAnalysis } from './ast-analyzer.js';

/**
 * Build a deduplicated undirected edge set from a map of import relationships.
 *
 * Each edge [u, v] is stored with u < v to ensure deduplication.
 * The key used for deduplication is `min(source,target)|||max(source,target)`.
 *
 * @param imports — Map from file path to set of imported file paths
 * @param filePaths — ordered array of file paths (index = node id). If not
 *                    provided, the keys of `imports` are used.
 * @returns array of [u, v] index pairs where u < v
 */
export function buildUndirectedEdges(
  imports: Map<string, Set<string>>,
  filePaths?: string[],
): [number, number][] {
  const paths = filePaths ?? Array.from(imports.keys());
  const pathToIndex = new Map<string, number>();
  for (let i = 0; i < paths.length; i++) {
    pathToIndex.set(paths[i]!, i);
  }

  const edgeKeys = new Set<string>();
  const edges: [number, number][] = [];

  for (const [source, targets] of imports) {
    const u = pathToIndex.get(source);
    if (u === undefined) continue;
    for (const target of targets) {
      const v = pathToIndex.get(target);
      if (v === undefined) continue;
      // Undirected: normalize so smaller index is first
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      const key = `${a}|||${b}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push([a, b]);
      }
    }
  }

  return edges;
}

/**
 * Build an adjacency list from an undirected edge set.
 *
 * @param edges — array of [u, v] index pairs
 * @param n     — total number of nodes
 * @returns Map from node index to set of neighbor indices
 */
export function buildAdjacencyList(
  edges: [number, number][],
  n: number,
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    adj.set(i, new Set());
  }
  for (const [u, v] of edges) {
    adj.get(u)!.add(v);
    adj.get(v)!.add(u);
  }
  return adj;
}

/**
 * Compute the I/O degree for each file based on its import relationships.
 * Degree = number of other files this file imports or is imported by.
 *
 * @param analyses — array of FileAnalysis with populated imports
 * @returns parallel array of degree counts
 */
export function computeIODegrees(analyses: FileAnalysis[]): number[] {
  // Build adjacency from import data
  const filePaths = analyses.map((a) => a.filePath);
  const imports = new Map<string, Set<string>>();
  for (const a of analyses) {
    imports.set(a.filePath, new Set(a.imports));
  }

  const edges = buildUndirectedEdges(imports, filePaths);
  const adj = buildAdjacencyList(edges, filePaths.length);

  return filePaths.map((_, i) => adj.get(i)?.size ?? 0);
}
