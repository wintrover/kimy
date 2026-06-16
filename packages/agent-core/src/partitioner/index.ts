/**
 * partitioner — AST + Z3 SMT workload partitioner.
 *
 * Re-exports all public types and functions from the partitioner modules:
 *   - ast-analyzer: AST parsing and cost metric computation
 *   - cost-model: weight computation with configurable coefficients
 *   - dependency-graph: undirected coupling graph construction
 *   - types: shared type definitions
 *   - z3-solver: Z3 SMT-based optimal partitioning with greedy fallback
 *   - wasm-locator: tree-sitter-nim WASM binary resolution
 */

// AST analysis
export {
  analyzeSourceCode,
  analyzeSourceFiles,
  hasParseError,
  computeCyclomaticComplexity,
  detectImports,
  type CostMetrics,
  type FileAnalysis,
} from './ast-analyzer.js';

// Cost model
export {
  computeWeight,
  computeWeights,
  COST_COEFFICIENTS,
} from './cost-model.js';

// Dependency graph
export {
  buildUndirectedEdges,
  buildAdjacencyList,
  computeIODegrees,
} from './dependency-graph.js';

// Shared types
export type { PartitionResult } from './types.js';

// Z3 solver / greedy fallback
export {
  solveSwarmPartition,
  greedyBinPackFallback,
  partitionFiles,
} from './z3-solver.js';

// Workspace isolation (git worktree-based race condition prevention)
export {
  createIsolatedWorkspaces,
  computeDeterministicMergeOrder,
  mergeWorkspaces,
  cleanupWorkspaces,
  type WorkspaceIsolationConfig,
  type IsolatedWorkspace,
  type WorkspaceIsolationResult,
  type MergeResult,
} from './workspace-isolation.js';

// WASM locator
export {
  resolveTreeSitterNimWasm,
  wasmUnavailableMessage,
  type WasmResolution,
  type WasmResolutionSource,
} from './wasm-locator.js';
