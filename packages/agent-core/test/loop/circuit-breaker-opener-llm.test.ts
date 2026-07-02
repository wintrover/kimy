import { describe, it, expect, vi } from 'vitest';

import type { LLM, LLMChatResponse } from '#/loop/llm';
import { CircuitBreakerOpenerLLM } from '#/loop/circuit-breaker-opener-llm';

function createMockLLM(overrides?: Partial<LLM>): LLM {
  return {
    systemPrompt: 'test',
    modelName: 'test-model',
    isRetryableError: () => true,
    chat: vi.fn().mockResolvedValue({ toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } }),
    ...overrides,
  };
}

function rateLimitedError(): Error {
  return Object.assign(new Error('Rate limited'), { statusCode: 429 });
}

function internalServerError(): Error {
  return Object.assign(new Error('Internal error'), { statusCode: 500 });
}

function makeDeps(overrides?: {
  forceOpen?: ReturnType<typeof vi.fn>;
  resolveProvider?: ReturnType<typeof vi.fn>;
  log?: { debug: ReturnType<typeof vi.fn> };
}) {
  const forceOpen = overrides?.forceOpen ?? vi.fn();
  const resolveProvider = overrides?.resolveProvider ?? vi.fn().mockReturnValue({ providerName: 'test-provider' });
  const log = overrides?.log;
  return {
    circuitBreaker: { forceOpen },
    resolveProvider,
    log,
  };
}

const dummyParams = { messages: [], tools: [], signal: new AbortController().signal };

describe('CircuitBreakerOpenerLLM', () => {
  it('force-opens circuit breaker for correct provider on 429', async () => {
    const forceOpen = vi.fn();
    const resolveProvider = vi.fn().mockReturnValue({ providerName: 'openai' });
    const inner = createMockLLM({
      chat: vi.fn().mockRejectedValue(rateLimitedError()),
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps({ forceOpen, resolveProvider }));

    await expect(llm.chat(dummyParams)).rejects.toThrow('Rate limited');

    expect(forceOpen).toHaveBeenCalledWith('openai');
    expect(resolveProvider).toHaveBeenCalledWith('test-model');
  });

  it('re-throws the 429 error after opening the circuit', async () => {
    const error = rateLimitedError();
    const inner = createMockLLM({
      chat: vi.fn().mockRejectedValue(error),
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps());

    await expect(llm.chat(dummyParams)).rejects.toBe(error);
  });

  it('returns false from isRetryableError for 429', () => {
    const inner = createMockLLM();
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps());

    expect(llm.isRetryableError(rateLimitedError())).toBe(false);
  });

  it('delegates isRetryableError to inner LLM for non-429 errors', () => {
    const inner = createMockLLM({ isRetryableError: () => true });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps());

    expect(llm.isRetryableError(internalServerError())).toBe(true);
  });

  it('returns false from isRetryableError for non-429 when inner returns false', () => {
    const inner = createMockLLM({ isRetryableError: () => false });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps());

    expect(llm.isRetryableError(internalServerError())).toBe(false);
  });

  it('does NOT open circuit on non-429 error and re-throws', async () => {
    const forceOpen = vi.fn();
    const error = internalServerError();
    const inner = createMockLLM({
      chat: vi.fn().mockRejectedValue(error),
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps({ forceOpen }));

    await expect(llm.chat(dummyParams)).rejects.toBe(error);
    expect(forceOpen).not.toHaveBeenCalled();
  });

  it('passes through normally on success with no circuit action', async () => {
    const forceOpen = vi.fn();
    const response: LLMChatResponse = {
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20 },
    };
    const inner = createMockLLM({
      chat: vi.fn().mockResolvedValue(response),
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps({ forceOpen }));

    const result = await llm.chat(dummyParams);

    expect(result).toBe(response);
    expect(forceOpen).not.toHaveBeenCalled();
  });

  it('logs the circuit breaker open event when log is provided', async () => {
    const debug = vi.fn();
    const inner = createMockLLM({
      chat: vi.fn().mockRejectedValue(rateLimitedError()),
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps({
      log: { debug },
      resolveProvider: vi.fn().mockReturnValue({ providerName: 'anthropic' }),
    }));

    await expect(llm.chat(dummyParams)).rejects.toThrow();

    expect(debug).toHaveBeenCalledWith(
      'circuit breaker opened for anthropic (test-model)',
    );
  });

  it('does not log when resolveProvider returns undefined', async () => {
    const debug = vi.fn();
    const inner = createMockLLM({
      chat: vi.fn().mockRejectedValue(rateLimitedError()),
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps({
      log: { debug },
      resolveProvider: vi.fn().mockReturnValue(undefined),
    }));

    await expect(llm.chat(dummyParams)).rejects.toThrow();

    expect(debug).not.toHaveBeenCalled();
  });

  it('proxies systemPrompt, modelName, and capability from inner LLM', () => {
    const inner = createMockLLM({
      systemPrompt: 'my prompt',
      modelName: 'my-model',
      capability: { maxTokens: 8192 },
    });
    const llm = new CircuitBreakerOpenerLLM(inner, makeDeps());

    expect(llm.systemPrompt).toBe('my prompt');
    expect(llm.modelName).toBe('my-model');
    expect(llm.capability).toEqual({ maxTokens: 8192 });
  });
});
