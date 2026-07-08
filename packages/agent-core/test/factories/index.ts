import { Factory } from 'fishery';
import { z } from 'zod';
import type { ModelCapability } from '@moonshot-ai/kosong';
import type { TokenUsage } from '@moonshot-ai/kosong';
import type { Logger } from '#/logging/types';
import type { LLM, LLMChatResponse } from '#/loop/llm';
import { vi } from 'vitest';

// ── Zod Schemas (satisfies로 컴파일 타임 검증) ────────────

export const ModelCapabilitySchema = z.object({
  image_in: z.boolean(),
  video_in: z.boolean(),
  audio_in: z.boolean(),
  thinking: z.boolean(),
  tool_use: z.boolean(),
  max_context_tokens: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative(),
}) satisfies z.ZodType<ModelCapability>;

export const TokenUsageSchema = z.object({
  inputOther: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  inputCacheRead: z.number().int().nonnegative(),
  inputCacheCreation: z.number().int().nonnegative(),
}) satisfies z.ZodType<TokenUsage>;

// ── Zod safeParse 헬퍼 (런타임 검증) ──────────────────────

export function assertValidCapability(input: unknown): ModelCapability {
  return ModelCapabilitySchema.parse(input);
}

export function assertValidUsage(input: unknown): TokenUsage {
  return TokenUsageSchema.parse(input);
}

// ── Trait Factory: ModelCapability ────────────────────────

class CapabilityFactory extends Factory<ModelCapability> {
  thinking() {
    return this.params({ thinking: true });
  }

  vision() {
    return this.params({ image_in: true, video_in: true });
  }

  audio() {
    return this.params({ audio_in: true });
  }

  multimodal() {
    return this.params({
      image_in: true, video_in: true, audio_in: true,
    });
  }

  maxOutput(tokens: number) {
    return this.params({ max_output_tokens: tokens });
  }
}

export const capabilityFactory = CapabilityFactory.define(() => ({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
  max_output_tokens: 4096,
}));

// ── Trait Factory: TokenUsage ─────────────────────────────

class UsageFactory extends Factory<TokenUsage> {
  withInput(tokens: number) {
    return this.params({ inputOther: tokens });
  }

  withOutput(tokens: number) {
    return this.params({ output: tokens });
  }

  cached(read: number, creation: number) {
    return this.params({
      inputCacheRead: read,
      inputCacheCreation: creation,
    });
  }
}

export const usageFactory = UsageFactory.define(() => ({
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
}));

// ── Trait Factory: Logger ─────────────────────────────────

const noop = vi.fn();

class LoggerFactory extends Factory<Logger> {
  recording() {
    return this.params({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      createChild: (_ctx?: Record<string, unknown>): Logger => loggerFactory.recording().build(),
    });
  }
}

export const loggerFactory: LoggerFactory = LoggerFactory.define(() => ({
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  createChild: (_ctx?: Record<string, unknown>): Logger => loggerFactory.build(),
}));

// ── Trait Factory: LLM (sequence + associations 활용) ─────

class LLMFactory extends Factory<LLM> {
  thinking() {
    return this.params({
      capability: capabilityFactory.thinking().build(),
    });
  }

  vision() {
    return this.params({
      capability: capabilityFactory.vision().build(),
    });
  }

  withToolCalls(calls: LLMChatResponse['toolCalls']) {
    return this.afterBuild((llm) => {
      vi.mocked(llm.chat).mockResolvedValue({
        toolCalls: calls,
        usage: usageFactory.build(),
      } as LLMChatResponse);
    });
  }
}

export const llmFactory = LLMFactory.define(({ sequence, associations }) => ({
  systemPrompt: 'test system prompt',
  modelName: `test-model-${sequence}`,
  capability: associations.capability || capabilityFactory.build(),
  isRetryableError: () => false,
  chat: vi.fn().mockResolvedValue({
    toolCalls: [],
    usage: usageFactory.build(),
  } as LLMChatResponse),
}));
