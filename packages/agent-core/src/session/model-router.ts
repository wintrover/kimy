/**
 * Pure deterministic model routing function.
 *
 * resolveModel() is a pure function: no side effects, same input → same output.
 * It can be formally verified (e.g., with Z3 SMT solver).
 *
 * The routing decision is based on a priority tier system:
 *   Tier 0: rate-limit fallback pool (circuit-breaker aware)
 *   Tier 1: runtime override
 *   Tier 2: config subagent_model
 *   Tier 3: parent model
 *   Tier 4: global default
 */

import type { CircuitState } from './provider-circuit-breaker';
import type { ProviderCircuitBreaker } from './provider-circuit-breaker';

/** Immutable input for the routing decision */
export interface RoutingInput {
  /** Current rate-limited state */
  readonly isRateLimited: boolean;
  /** Runtime override (Tier 1) */
  readonly runtimeModel?: string;
  /** Config file's subagent_model (Tier 2) */
  readonly configSubagentModel?: string;
  /** Parent agent's model (Tier 3) */
  readonly parentModel?: string;
  /** Config file's default_model (Tier 4) */
  readonly defaultModel?: string;
  /** Fallback priority pool */
  readonly fallbackPriority?: readonly string[];
  /** Circuit breaker state map: providerId → circuitState */
  readonly circuitStates?: ReadonlyMap<string, CircuitState>;
  /** models registry: alias → providerId mapping */
  readonly modelProviderMap?: ReadonlyMap<string, string>;
}

/** Routing decision output */
export interface RoutingOutput {
  readonly selectedModel: string;
  readonly tier: 0 | 1 | 2 | 3 | 4;
  readonly reason: string;
}

/**
 * Pure function: no side effects, same input → same output.
 */
export function resolveModel(input: RoutingInput): RoutingOutput {
  // Tier 1-4: standard priority chain (defined first for reuse)
  const tiers: Array<[string | undefined, number, string]> = [
    [input.runtimeModel, 1, 'runtime_override'],
    [input.configSubagentModel, 2, 'config_subagent_model'],
    [input.parentModel, 3, 'parent_model'],
    [input.defaultModel, 4, 'global_default'],
  ];

  // Tier 0: rate-limit fallback (circuit-breaker aware)
  // Triggers on:
  //   (a) explicit batch rate-limit flag, OR
  //   (b) implicit: primary model's provider circuit is open
  if (input.fallbackPriority?.length) {
    const isExplicitlyRateLimited = input.isRateLimited;

    // Extract primaryModel: first tier-1..4 model that has a registered provider
    // (unregistered models like runtime overrides have no circuit state to check)
    const primaryModel = tiers.find(
      ([model]) => !!model && input.modelProviderMap?.has(model!),
    )?.[0];
    const primaryProviderId = primaryModel
      ? input.modelProviderMap?.get(primaryModel)
      : undefined;
    const primaryCircuitState = primaryProviderId
      ? input.circuitStates?.get(primaryProviderId)
      : undefined;
    const isImplicitlyRateLimited = primaryCircuitState === 'open';

    if (isExplicitlyRateLimited || isImplicitlyRateLimited) {
      for (const candidate of input.fallbackPriority) {
        const providerId = input.modelProviderMap?.get(candidate);
        const circuitState = providerId
          ? input.circuitStates?.get(providerId)
          : undefined;
        if (!circuitState || circuitState === 'closed' || circuitState === 'half_open') {
          return { selectedModel: candidate, tier: 0, reason: 'rate_limit_fallback' };
        }
      }
      // All fallbacks open → fall through to standard chain
    }
  }

  // Tier 1-4: standard priority chain (reuse same tiers array)
  for (const [model, tier, reason] of tiers) {
    if (model) return { selectedModel: model, tier: tier as 1 | 2 | 3 | 4, reason };
  }

  return { selectedModel: '', tier: 4, reason: 'no_model_configured' };
}

// ── Snapshot utilities (read-only topology injection) ────────────

/**
 * Create a frozen snapshot of circuit breaker states.
 * The snapshot is isolated from subsequent mutations to the breaker.
 */
export function createCircuitSnapshot(
  breaker: ProviderCircuitBreaker,
): ReadonlyMap<string, CircuitState> {
  const snapshot = breaker.getAllStates();
  return Object.freeze(new Map(snapshot)) as ReadonlyMap<string, CircuitState>;
}

/**
 * Create a deeply frozen RoutingInput snapshot.
 * Prevents async callback contamination of routing decisions.
 */
export function createRoutingSnapshot(
  input: Omit<RoutingInput, 'circuitStates'> & { circuitStates?: ReadonlyMap<string, CircuitState> },
): Readonly<RoutingInput> {
  return Object.freeze({
    ...input,
    circuitStates: input.circuitStates
      ? Object.freeze(new Map(input.circuitStates))
      : undefined,
    fallbackPriority: input.fallbackPriority
      ? Object.freeze([...input.fallbackPriority])
      : undefined,
  });
}
