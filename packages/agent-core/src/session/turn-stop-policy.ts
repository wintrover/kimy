/**
 * TurnStopPolicy — extensible turn-stop decision chain.
 *
 * When the LLM stops without tool calls (`end_turn`), the turn loop
 * iterates registered policies before falling through to the default
 * stop. Each policy can request a continuation (with an injected
 * message) or a forced stop. Returning `undefined` means "pass through".
 *
 * This follows the same chain-of-responsibility pattern as
 * `PermissionPolicy` (permission/types.ts).
 */

import type { LoopTerminalStepStopReason } from '#/loop/types';

/** Context passed to TurnStopPolicy.evaluate(). */
export interface TurnStopPolicyContext {
  readonly stopReason: LoopTerminalStepStopReason;
  /** Tool call names executed during this turn (accumulated from afterToolBatch). */
  readonly toolCallNames: ReadonlySet<string>;
}

/** Result returned by a TurnStopPolicy. */
export interface TurnStopPolicyResult {
  readonly continue: boolean;
  /** Message to inject into context when continue is true. */
  readonly message?: string;
  /** Origin name for the injected message (defaults to policy.name). */
  readonly originName?: string;
}

export interface TurnStopPolicy {
  readonly name: string;
  evaluate(ctx: TurnStopPolicyContext): TurnStopPolicyResult | undefined | Promise<TurnStopPolicyResult | undefined>;
}

// ---------------------------------------------------------------------------
// Factory — wires all built-in turn-stop policies.
// ---------------------------------------------------------------------------

import type { Agent } from '#/agent';
import { PlanModeTurnStopPolicy } from '#/agent/plan/plan-mode-turn-stop-policy';

export function createTurnStopPolicies(agent: Agent): readonly TurnStopPolicy[] {
  return [new PlanModeTurnStopPolicy(agent)];
}
