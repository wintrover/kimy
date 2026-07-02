import type { LLM } from '#/loop/llm';
import { CircuitBreakerOpenerLLM } from '#/loop/circuit-breaker-opener-llm';
import { resolveModel, createCircuitSnapshot, createRoutingSnapshot } from './model-router';
import { getEffectiveFallbackModel } from './fallback-resolver';
import type { ProviderCircuitBreaker } from './provider-circuit-breaker';
import type { Agent } from '#/agent';
import type { BatchExecutionContext } from './subagent-batch';

export interface ChildLLMFactoryInput {
  readonly parent: Agent;
  readonly child: Agent;
  readonly circuitBreaker: ProviderCircuitBreaker;
  readonly config?: {
    readonly subagentModel?: string;
    readonly defaultModel?: string;
    readonly subagentFallbackModel?: string;
  };
  readonly runtimeModel?: string;
  readonly context?: BatchExecutionContext;
  readonly log?: { debug(msg: string, meta?: unknown): void };
}

export interface ChildLLMResult {
  readonly llm: LLM;
  readonly selectedModel: string;
}

/**
 * Creates an immutable LLM for a subagent turn.
 *
 * Pure factory — reads current circuit breaker state + config snapshot,
 * resolves the optimal model via resolveModel(), and produces a static LLM.
 * Wrapped with CircuitBreakerOpenerLLM for 429 circuit-breaker side effect.
 *
 * Returns both the LLM and the selected model name so the caller can
 * update `child.config.modelAlias` (required by the turn's step loop).
 *
 * Called at turn start. On batch retry, called again with updated circuit state
 * → naturally produces the fallback model if the primary is rate-limited.
 */
export function createChildLLM(input: ChildLLMFactoryInput): ChildLLMResult {
  const { parent, child, circuitBreaker, config, runtimeModel, context } = input;

  // Build model→provider map
  const dynamicProviderMap = new Map<string, string>();
  if (child.modelProvider) {
    const candidates = [
      runtimeModel,
      config?.subagentModel,
      parent.config.modelAlias,
      config?.defaultModel,
      config?.subagentFallbackModel,
    ].filter((m): m is string => !!m);
    for (const model of new Set(candidates)) {
      try {
        const { providerName } = child.modelProvider.resolveProviderConfig(model);
        dynamicProviderMap.set(model, providerName);
      } catch { /* unregistered model — skip */ }
    }
  }

  // Resolve model (pure function)
  const fallbackModel = getEffectiveFallbackModel(
    config?.subagentFallbackModel,
    context?.fallbackModel,
  );
  const snapshot = createRoutingSnapshot({
    isRateLimited: context?.isRateLimited ?? false,
    runtimeModel,
    configSubagentModel: config?.subagentModel,
    parentModel: parent.config.modelAlias,
    defaultModel: config?.defaultModel,
    fallbackPriority: fallbackModel ? [fallbackModel] : undefined,
    circuitStates: createCircuitSnapshot(circuitBreaker),
    modelProviderMap: dynamicProviderMap,
  });
  const { selectedModel } = resolveModel(snapshot);

  // Create immutable LLM
  const rawLLM = child.buildLLMForModel(selectedModel);

  // Wrap with circuit-breaker opener (single side effect on 429)
  const llm = new CircuitBreakerOpenerLLM(rawLLM, {
    circuitBreaker,
    resolveProvider: (modelName) => {
      try {
        return child.modelProvider?.resolveProviderConfig(modelName);
      } catch { return undefined; }
    },
    log: input.log,
  });

  return { llm, selectedModel };
}
