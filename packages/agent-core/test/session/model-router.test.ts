import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../src/session/model-router';
import type { RoutingInput } from '../../src/session/model-router';
import type { CircuitState } from '../../src/session/provider-circuit-breaker';

describe('resolveModel', () => {
  const modelProviderMap = new Map<string, string>([
    ['mimo-v2.5', 'minimax'],
    ['deepseek/deepseek-v4-flash', 'deepseek'],
  ]);

  const base: RoutingInput = {
    isRateLimited: false,
    runtimeModel: 'gpt-4o',
    configSubagentModel: 'mimo-v2.5',
    defaultModel: 'claude-3.5',
    fallbackPriority: ['deepseek/deepseek-v4-flash'],
    modelProviderMap,
  };

  it('1. explicit rate-limit → tier 0 fallback', () => {
    const circuitStates = new Map<string, CircuitState>([['deepseek', 'closed']]);
    const result = resolveModel({ ...base, isRateLimited: true, circuitStates });
    expect(result.tier).toBe(0);
    expect(result.selectedModel).toBe('deepseek/deepseek-v4-flash');
    expect(result.reason).toBe('rate_limit_fallback');
  });

  it('2. implicit circuit-open → tier 0 fallback (THE BUG SCENARIO)', () => {
    // primary is mimo-v2.5 → provider 'minimax' circuit is open
    const circuitStates = new Map<string, CircuitState>([
      ['minimax', 'open'],
      ['deepseek', 'closed'],
    ]);
    const result = resolveModel({ ...base, isRateLimited: false, circuitStates });
    expect(result.tier).toBe(0);
    expect(result.selectedModel).toBe('deepseek/deepseek-v4-flash');
    expect(result.reason).toBe('rate_limit_fallback');
  });

  it('3. circuit closed + no rate-limit → no fallback, tier 2', () => {
    const circuitStates = new Map<string, CircuitState>([['minimax', 'closed']]);
    const result = resolveModel({ ...base, isRateLimited: false, runtimeModel: undefined, circuitStates });
    expect(result.tier).toBe(2);
    expect(result.selectedModel).toBe('mimo-v2.5');
    expect(result.reason).toBe('config_subagent_model');
  });

  it('4. all fallbacks open → fall through to tier 1', () => {
    const circuitStates = new Map<string, CircuitState>([
      ['minimax', 'open'],
      ['deepseek', 'open'],
    ]);
    const result = resolveModel({ ...base, isRateLimited: true, circuitStates });
    expect(result.tier).toBe(1);
    expect(result.selectedModel).toBe('gpt-4o');
    expect(result.reason).toBe('runtime_override');
  });

  it('5. primary circuit open + empty fallbackPriority → standard chain tier 1', () => {
    const circuitStates = new Map<string, CircuitState>([['minimax', 'open']]);
    const result = resolveModel({
      ...base,
      isRateLimited: false,
      circuitStates,
      fallbackPriority: [],
    });
    expect(result.tier).toBe(1);
    expect(result.selectedModel).toBe('gpt-4o');
    expect(result.reason).toBe('runtime_override');
  });

  it('6. primary circuit half_open → no fallback, tier 2', () => {
    const circuitStates = new Map<string, CircuitState>([['minimax', 'half_open']]);
    const result = resolveModel({ ...base, isRateLimited: false, runtimeModel: undefined, circuitStates });
    expect(result.tier).toBe(2);
    expect(result.selectedModel).toBe('mimo-v2.5');
    expect(result.reason).toBe('config_subagent_model');
  });

  it('7. empty fallbackPriority → implicit trigger ignored, tier 1', () => {
    const circuitStates = new Map<string, CircuitState>([['minimax', 'open']]);
    const result = resolveModel({
      ...base,
      isRateLimited: false,
      circuitStates,
      fallbackPriority: [],
    });
    expect(result.tier).toBe(1);
    expect(result.selectedModel).toBe('gpt-4o');
    expect(result.reason).toBe('runtime_override');
  });

  it('8. primaryModel same as fallback candidate with open circuit → skip to next', () => {
    const extendedMap = new Map(modelProviderMap);
    extendedMap.set('openai/gpt-4o-mini', 'openai');
    const circuitStates = new Map<string, CircuitState>([['deepseek', 'open']]);
    const result = resolveModel({
      ...base,
      runtimeModel: undefined,
      configSubagentModel: 'deepseek/deepseek-v4-flash',
      fallbackPriority: ['deepseek/deepseek-v4-flash', 'openai/gpt-4o-mini'],
      circuitStates,
      modelProviderMap: extendedMap,
    });
    expect(result.tier).toBe(0);
    expect(result.selectedModel).toBe('openai/gpt-4o-mini');
    expect(result.reason).toBe('rate_limit_fallback');
  });
});
