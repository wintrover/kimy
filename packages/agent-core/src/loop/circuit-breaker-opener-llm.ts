/**
 * Wraps an LLM and force-opens the circuit breaker on 429 rate-limit errors —
 * a single side-effect boundary so the routing layer stays pure.
 */

import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

export interface CircuitBreakerOpenerLLMOptions {
  readonly circuitBreaker: { forceOpen(providerId: string): void };
  readonly resolveProvider?: (
    modelName: string,
  ) => { providerName: string } | undefined;
  readonly log?: { debug(msg: string): void };
}

export class CircuitBreakerOpenerLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability;

  constructor(
    private readonly inner: LLM,
    private readonly options: CircuitBreakerOpenerLLMOptions,
  ) {
    this.systemPrompt = inner.systemPrompt;
    this.modelName = inner.modelName;
    this.capability = inner.capability;
  }

  isRetryableError(error: unknown): boolean {
    if (this.isRateLimitError(error)) return false;
    return this.inner.isRetryableError?.(error) ?? false;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    try {
      return await this.inner.chat(params);
    } catch (error) {
      if (this.isRateLimitError(error)) {
        const resolved = this.options.resolveProvider?.(this.modelName);
        if (resolved) {
          this.options.circuitBreaker.forceOpen(resolved.providerName);
          this.options.log?.debug(
            `circuit breaker opened for ${resolved.providerName} (${this.modelName})`,
          );
        }
      }
      throw error;
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const statusCode = (error as unknown as Record<string, unknown>)['statusCode'];
    return statusCode === 429;
  }
}
