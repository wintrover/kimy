/**
 * z3-solver — Z3 SMT solver integration for optimal workload partitioning.
 *
 * Z3_optimize_check runs on a separate thread automatically (per official docs).
 * NO worker_threads needed. Timeout uses Promise.race, not AbortSignal.
 *
 * Falls back to greedy bin-packing when Z3 times out or is unavailable.
 */

import type { FileAnalysis } from './ast-analyzer.js';
import { computeWeights } from './cost-model.js';
import { buildUndirectedEdges } from './dependency-graph.js';
import { type PartitionResult } from './types.js';

// Re-export PartitionResult for consumers importing from this module
export type { PartitionResult } from './types.js';

// ---------------------------------------------------------------------------
// Z3 dynamic import helper
// ---------------------------------------------------------------------------

/** Minimal type for the z3-solver WASM context returned by init(). */
interface Z3Ctx {
  Bool(name: string): unknown;
  Int(name: string): unknown;
  Real(name: string): unknown;
  IntVal(v: number): unknown;
  Sum(...args: unknown[]): unknown;
  Add(...args: unknown[]): unknown;
  Sub(a: unknown, b: unknown): unknown;
  Mul(a: unknown, b: unknown): unknown;
  Le(a: unknown, b: unknown): unknown;
  Ge(a: unknown, b: unknown): unknown;
  Eq(a: unknown, b: unknown): unknown;
  Ite(c: unknown, t: unknown, f: unknown): unknown;
  Or(...args: unknown[]): unknown;
  And(...args: unknown[]): unknown;
  Not(a: unknown): unknown;
  Implies(a: unknown, b: unknown): unknown;
  interrupt(): void;
}

interface Z3Optimize {
  add(assertion: unknown): void;
  addSoft(term: unknown, weight?: unknown, id?: string): void;
  check(): string;
  model(): Record<string, unknown> | undefined;
}

let z3Ctx: Z3Ctx | undefined;

async function getZ3(): Promise<{ ctx: Z3Ctx; Optimize: () => Z3Optimize } | undefined> {
  if (z3Ctx !== undefined) {
    // Already initialized; we need the Optimize constructor too
    try {
      const mod = await import('z3-solver') as unknown as { Optimize: () => Z3Optimize };
      return { ctx: z3Ctx, Optimize: mod.Optimize };
    } catch {
      return undefined;
    }
  }
  try {
    const mod = (await import('z3-solver')) as unknown as {
      init(): Promise<{ Optimize: () => Z3Optimize } & Z3Ctx>;
    };
    const full = await mod.init();
    // The init() return value is the context itself with all Z3 functions
    z3Ctx = full as unknown as Z3Ctx;
    return { ctx: z3Ctx, Optimize: (full as unknown as { Optimize: () => Z3Optimize }).Optimize };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Greedy bin-pack fallback
// ---------------------------------------------------------------------------

/**
 * Greedy bin-packing: sort tasks by weight descending, assign each to
 * the least-loaded agent. Deterministic, fast, no dependencies.
 */
export function greedyBinPackFallback(
  W: number[],
  N: number,
  reason: string,
): PartitionResult {
  const n = W.length;
  const assignment = new Array<number>(n);
  const agentLoads = new Array<number>(N).fill(0);

  // Create index array sorted by weight descending
  const sortedIndices = Array.from({ length: n }, (_, i) => i);
  sortedIndices.sort((a, b) => W[b]! - W[a]!);

  for (const idx of sortedIndices) {
    // Find least-loaded agent
    let minLoad = Infinity;
    let minAgent = 0;
    for (let a = 0; a < N; a++) {
      if (agentLoads[a]! < minLoad) {
        minLoad = agentLoads[a]!;
        minAgent = a;
      }
    }
    assignment[idx] = minAgent;
    agentLoads[minAgent]! += W[idx]!;
  }

  const T_max = Math.max(...agentLoads);

  return {
    assignment,
    agentLoads,
    T_max,
    solver: 'greedy-fallback',
    reason,
  };
}

// ---------------------------------------------------------------------------
// Z3 solver
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Solve the swarm partitioning problem using Z3 SMT optimizer.
 *
 * Model:
 *   Variables: x[j][i] = Bool (task j assigned to agent i)
 *             cut[u][v] = Bool (edge {u,v} is cut)
 *   Constraints:
 *     1. Each task assigned to exactly 1 agent
 *     2. Σ W_j·x_j_i ≤ T_max for each agent i
 *     3. cut_uv ≥ x_ui - x_vi  and  cut_uv ≥ x_vi - x_ui  (linearization)
 *   Objectives:
 *     1. minimize T_max
 *     2. minimize Σ C_uv · cut_uv  (secondary)
 *
 * @param W          — task weights
 *   edges      — undirected edge pairs [u, v]
 *   N          — number of agents
 *   timeoutMs  — solver timeout (default 30s)
 */
export async function solveSwarmPartition(
  W: number[],
  edges: [number, number][],
  N: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PartitionResult> {
  // Edge cases
  if (W.length === 0) {
    return {
      assignment: [],
      agentLoads: new Array<number>(N).fill(0),
      T_max: 0,
      solver: 'z3',
    };
  }
  if (N <= 0) {
    return greedyBinPackFallback(W, Math.max(W.length, 1), 'N must be positive');
  }

  // Try Z3
  const z3 = await getZ3();
  if (z3 === undefined) {
    return greedyBinPackFallback(W, N, 'z3-solver not available');
  }

  try {
    return await solveWithZ3(z3.ctx, z3.Optimize, W, edges, N, timeoutMs);
  } catch (err) {
    return greedyBinPackFallback(W, N, `Z3 solve failed: ${String(err)}`);
  }
}

async function solveWithZ3(
  ctx: Z3Ctx,
  Optimize: () => Z3Optimize,
  W: number[],
  edges: [number, number][],
  N: number,
  timeoutMs: number,
): Promise<PartitionResult> {
  const T = W.length; // number of tasks
  const opt = Optimize();

  // --- Variables ---

  // x[j][i] = Bool: task j assigned to agent i
  const x: unknown[][] = [];
  for (let j = 0; j < T; j++) {
    x[j] = [];
    for (let i = 0; i < N; i++) {
      x[j]![i] = ctx.Bool(`x_${j}_${i}`);
    }
  }

  // cut[e] = Bool: edge e is cut (endpoints on different agents)
  const cut: unknown[] = [];
  for (const [u, v] of edges) {
    cut.push(ctx.Bool(`cut_${u}_${v}`));
  }

  // T_max: integer upper bound on agent load (minimized)
  const Tmax = ctx.Int('T_max');

  // --- Constraints ---

  // 1. Each task assigned to exactly 1 agent: Σ_i x[j][i] == 1
  for (let j = 0; j < T; j++) {
    const terms: unknown[] = [];
    for (let i = 0; i < N; i++) {
      // Convert Bool to Int: Ite(x[j][i], 1, 0)
      terms.push(ctx.Ite(x[j]![i], ctx.IntVal(1), ctx.IntVal(0)));
    }
    opt.add(ctx.Eq(ctx.Sum(...terms), ctx.IntVal(1)));
  }

  // 2. Agent load ≤ T_max: Σ_j (W_j * Ite(x[j][i], 1, 0)) ≤ T_max
  for (let i = 0; i < N; i++) {
    const loadTerms: unknown[] = [];
    for (let j = 0; j < T; j++) {
      // W_j * x[j][i]  via  Mul(IntVal(W_j_scaled), Ite(x[j][i], IntVal(1), IntVal(0)))
      // Scale weights by 100 to work in integer domain
      const scaledW = Math.round(W[j]! * 100);
      loadTerms.push(
        ctx.Mul(ctx.IntVal(scaledW), ctx.Ite(x[j]![i], ctx.IntVal(1), ctx.IntVal(0))),
      );
    }
    opt.add(ctx.Le(ctx.Sum(...loadTerms), ctx.Mul(Tmax, ctx.IntVal(100))));
  }

  // 3. Cut linearization:
  //    For each edge (u, v) and each agent i:
  //      cut[e] ≥ x[u][i] - x[v][i]  (when x[u][i]=1, x[v][i]=0 → cut≥1)
  //      cut[e] ≥ x[v][i] - x[u][i]  (when x[v][i]=1, x[u][i]=0 → cut≥1)
  //
  // Linearized: cut[e] * 1 ≥ Ite(x[u][i],1,0) - Ite(x[v][i],1,0)
  //           and cut[e] * 1 ≥ Ite(x[v][i],1,0) - Ite(x[u][i],1,0)
  for (let e = 0; e < edges.length; e++) {
    const [u, v] = edges[e]!;
    const cutAsInt = ctx.Ite(cut[e], ctx.IntVal(1), ctx.IntVal(0));
    for (let i = 0; i < N; i++) {
      const xu = ctx.Ite(x[u]![i], ctx.IntVal(1), ctx.IntVal(0));
      const xv = ctx.Ite(x[v]![i], ctx.IntVal(1), ctx.IntVal(0));
      // cut ≥ xu - xv  →  cut - xu + xv ≥ 0  →  Le(Sub(cut, xu), xv) is wrong
      // Correct: Sub(xu, xv) ≤ cut  →  Le(Sub(xu, xv), cutAsInt)
      opt.add(ctx.Le(ctx.Sub(xu, xv), cutAsInt));
      opt.add(ctx.Le(ctx.Sub(xv, xu), cutAsInt));
    }
  }

  // --- Objectives ---

  // Primary: minimize T_max  (weight 1000 for lexicographic priority)
  opt.addSoft(Tmax, ctx.IntVal(1000), 'makespan');

  // Secondary: minimize Σ cut[e]  (weight 1 for secondary priority)
  if (cut.length > 0) {
    const cutAsInts = cut.map((c) => ctx.Ite(c, ctx.IntVal(1), ctx.IntVal(0)));
    opt.addSoft(ctx.Sum(...cutAsInts), ctx.IntVal(1), 'coupling');
  }

  // --- Solve with timeout ---

  let settled = false;

  const timeoutPromise = new Promise<PartitionResult>((resolve) => {
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ctx.interrupt(); } catch { /* ignore */ }
        resolve(greedyBinPackFallback(W, N, `Z3 solver timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });

  const solvePromise = (async (): Promise<PartitionResult> => {
    const status = opt.check();
    if (settled) {
      return greedyBinPackFallback(W, N, 'Z3 solver timed out (post-check)');
    }
    settled = true;

    if (status !== 'sat' && status !== 'optimal') {
      return greedyBinPackFallback(W, N, `Z3 returned status: ${status}`);
    }

    // Extract model
    const model = opt.model();
    if (model === undefined) {
      return greedyBinPackFallback(W, N, 'Z3 returned no model');
    }

    const assignment = new Array<number>(T).fill(0);
    const agentLoads = new Array<number>(N).fill(0);

    for (let j = 0; j < T; j++) {
      for (let i = 0; i < N; i++) {
        const val = model[`x_${j}_${i}`];
        const boolVal = extractBool(val);
        if (boolVal === true) {
          assignment[j] = i;
          agentLoads[i]! += W[j]!;
          break;
        }
      }
    }

    const T_max = Math.max(...agentLoads);
    return { assignment, agentLoads, T_max, solver: 'z3' };
  })();

  return Promise.race([solvePromise, timeoutPromise]);
}

/**
 * Extract a boolean value from a Z3 model entry.
 * Handles various Z3 WASM output formats.
 */
function extractBool(val: unknown): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if ('value' in obj) return Boolean(obj['value']);
    if ('toString' in obj) return obj.toString() === 'true';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// High-level API: analyze → partition
// ---------------------------------------------------------------------------

/**
 * Partition an array of file analyses into N agent groups.
 * Builds the dependency graph, computes weights, and solves via Z3 or greedy.
 */
export async function partitionFiles(
  analyses: FileAnalysis[],
  N: number,
  timeoutMs?: number,
): Promise<PartitionResult> {
  const filePaths = analyses.map((a) => a.filePath);
  const imports = new Map<string, Set<string>>();
  for (const a of analyses) {
    imports.set(a.filePath, new Set(a.imports));
  }
  const edges = buildUndirectedEdges(imports, filePaths);
  const W = computeWeights(analyses);
  return solveSwarmPartition(W, edges, N, timeoutMs);
}
