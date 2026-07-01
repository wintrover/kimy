import type { PermissionPolicy, PermissionPolicyResult } from './types';

// ---------------------------------------------------------------------------
// Combining Algorithms
//
// Each algorithm takes the set of non-undefined results produced by evaluating
// every policy in a layer and returns the winning decision *kind*. The evaluator
// then selects all policies whose result kind matches the winner and calls their
// `onSelected()` hooks. This guarantees that side effects fire for every tied
// policy, eliminating array-order dependency.
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export type CombiningAlgorithm = (
  decisions: ReadonlyArray<PolicyDecision>,
) => { kind: PermissionPolicyResult['kind'] } | undefined;

/**
 * Guards layer: deny wins over everything.
 * If any policy returns deny → deny. Otherwise, ask wins over approve.
 */
export const DenyOverrides: CombiningAlgorithm = (decisions) => {
  if (decisions.some((d) => d.result.kind === 'deny')) return { kind: 'deny' };
  if (decisions.some((d) => d.result.kind === 'ask')) return { kind: 'ask' };
  if (decisions.some((d) => d.result.kind === 'approve')) return { kind: 'approve' };
  return undefined;
};

/**
 * Overrides layer: approve wins over ask, ask wins over deny.
 * Designed for user/session overrides where explicit approval should
 * take precedence.
 */
export const PermitOverrides: CombiningAlgorithm = (decisions) => {
  if (decisions.some((d) => d.result.kind === 'approve')) return { kind: 'approve' };
  if (decisions.some((d) => d.result.kind === 'ask')) return { kind: 'ask' };
  if (decisions.some((d) => d.result.kind === 'deny')) return { kind: 'deny' };
  return undefined;
};

/**
 * Fallbacks layer: the first decision in array order wins.
 * This is the only algorithm with explicit order dependency — used for
 * the fallback layer where domain rules dictate "first match applies".
 */
export const FirstApplicable: CombiningAlgorithm = (decisions) =>
  decisions[0] ? { kind: decisions[0].result.kind } : undefined;

// ---------------------------------------------------------------------------
// Pipeline Structure
// ---------------------------------------------------------------------------

export interface PipelineLayer {
  readonly policies: PermissionPolicy[];
  readonly combine: CombiningAlgorithm;
}

/**
 * A 3-layer evaluation pipeline.
 *
 * Layers are evaluated in order (guards → overrides → fallbacks). Within each
 * layer, all policies are evaluated (in parallel when possible) and the layer's
 * combining algorithm deterministically selects the winning decision kind.
 * The first layer that produces a non-undefined result wins.
 */
export interface PermissionPipeline {
  /** Layer 0 — system security guards (deny-dominant). */
  readonly guards: PipelineLayer;
  /** Layer 1 — user/session/context overrides (permit-dominant). */
  readonly overrides: PipelineLayer;
  /** Layer 2 — system defaults and structural controls (first-applicable). */
  readonly fallbacks: PipelineLayer;
}
