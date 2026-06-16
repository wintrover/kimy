/**
 * cost-model — weighted cost computation for AST-parsed source files.
 *
 * Formula: W_j = α · (NodeCount / 100) + β · CC + γ · Degree
 *
 * NodeCount is divided by 100 for scale normalization so that a typical
 * file (200-800 nodes) yields a manageable weight contribution (2-8),
 * while cyclomatic complexity and I/O coupling dominate the signal.
 *
 * **DETERMINISTIC REPRODUCIBILITY GUARANTEE:**
 * α, β, γ are frozen `as const` and cannot be overridden at runtime.
 * This ensures identical input → identical partition across all sessions.
 * To change coefficients, modify this source file and rebuild.
 */

import type { FileAnalysis } from './ast-analyzer.js';

/**
 * Immutable cost model coefficients.
 *
 * Frozen with `Object.freeze` to prevent runtime mutation.
 * These values are the single source of truth for the weight function.
 *
 * | Coefficient | Value | Rationale |
 * |-------------|-------|-----------|
 * | α (alpha)   | 1.0   | Normalized node count contribution |
 * | β (beta)    | 2.0   | Cyclomatic complexity weighted 2× (dominates signal) |
 * | γ (gamma)   | 1.5   | I/O coupling penalizes cross-file dependencies |
 */
export const COST_COEFFICIENTS = Object.freeze({
  alpha: 1.0,
  beta: 2.0,
  gamma: 1.5,
} as const);

/**
 * Compute a single task weight from its cost metrics.
 *
 * Uses frozen constants from COST_COEFFICIENTS. No override parameters —
 * deterministic reproducibility requires identical coefficients everywhere.
 *
 * @param nodeCount   — raw AST node count (will be divided by 100)
 * @param cyclomaticComplexity — branch count + 1
 * @param ioDegree    — number of inter-file import edges
 * @returns weighted cost W_j
 */
export function computeWeight(
  nodeCount: number,
  cyclomaticComplexity: number,
  ioDegree: number,
): number {
  const { alpha, beta, gamma } = COST_COEFFICIENTS;
  return alpha * (nodeCount / 100) + beta * cyclomaticComplexity + gamma * ioDegree;
}

/**
 * Batch-compute weights for an array of file analyses.
 *
 * @param analyses — array of FileAnalysis (each contains metrics)
 * @returns parallel array of weights
 */
export function computeWeights(analyses: FileAnalysis[]): number[] {
  return analyses.map((a) =>
    computeWeight(
      a.metrics.nodeCount,
      a.metrics.cyclomaticComplexity,
      a.metrics.ioDegree,
    ),
  );
}
