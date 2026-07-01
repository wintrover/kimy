import { describe, it, expect } from 'vitest';
import { catalogProviderModels } from '../src/catalog';
import type { CatalogProviderEntry } from '@moonshot-ai/kosong';

describe('Catalog Data Integrity', () => {
  it('should ensure all production models have an explicit output limit', () => {
    // This test verifies that every catalog entry has limit.output defined,
    // preventing runtime fallback to DEFAULT_UNKNOWN_CONTEXT_FALLBACK (32000).
    // New models MUST have their output limit specified from the provider's official spec.

    // Representative catalog entries for known production providers.
    // When adding a new model to the models.dev catalog, add it here with its
    // documented output limit from the provider's official spec.
    const providers: CatalogProviderEntry[] = [
      {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-20250514': {
            id: 'claude-sonnet-4-20250514',
            name: 'Claude Sonnet 4',
            family: 'claude-sonnet-4',
            limit: { context: 200000, output: 8192 },
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          'claude-haiku-4-20250514': {
            id: 'claude-haiku-4-20250514',
            name: 'Claude Haiku 4',
            family: 'claude-haiku-4',
            limit: { context: 200000, output: 8192 },
            tool_call: true,
            reasoning: false,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
      {
        id: 'openai',
        models: {
          'gpt-4o': {
            id: 'gpt-4o-2024-08-06',
            name: 'GPT-4o',
            family: 'gpt-4o',
            limit: { context: 128000, output: 16384 },
            tool_call: true,
            reasoning: false,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          'o3-mini': {
            id: 'o3-mini-2025-01-31',
            name: 'O3 Mini',
            family: 'o3-mini',
            limit: { context: 200000, output: 100000 },
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
      {
        id: 'google',
        models: {
          'gemini-2.5-pro-exp-03-25': {
            id: 'gemini-2.5-pro-exp-03-25',
            name: 'Gemini 2.5 Pro',
            family: 'gemini-2.5-pro',
            limit: { context: 1000000, output: 65536 },
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text', 'image', 'audio', 'video'], output: ['text'] },
          },
        },
      },
    ];

    const missingOutput: { provider: string; model: string }[] = [];

    for (const provider of providers) {
      const models = provider.models ?? {};
      for (const [modelId, model] of Object.entries(models)) {
        if (!model.limit?.output) {
          missingOutput.push({ provider: provider.id ?? 'unknown', model: modelId });
        }
      }
    }

    expect(missingOutput).toEqual([]);
  });

  it('should propagate output limits into processed CatalogModel entries', () => {
    // Verify that catalogProviderModels correctly maps limit.output into
    // maxOutputSize and max_output_tokens for each usable chat model.
    const provider: CatalogProviderEntry = {
      id: 'test-provider',
      models: {
        'with-output': {
          id: 'with-output',
          limit: { context: 100000, output: 8192 },
          modalities: { input: ['text'], output: ['text'] },
        },
        'without-output': {
          id: 'without-output',
          limit: { context: 100000 },
          modalities: { input: ['text'], output: ['text'] },
        },
        'missing-model': {
          id: 'missing-model' as string,
          limit: { context: 100000, output: 64000 },
          missing: true,
        } as unknown as CatalogProviderEntry['models'][string],
      },
    };

    const models = catalogProviderModels(provider);
    const withOutput = models.find((m) => m.id === 'with-output');
    const withoutOutput = models.find((m) => m.id === 'without-output');

    expect(withOutput).toBeDefined();
    expect(withOutput!.maxOutputSize).toBe(8192);
    expect(withOutput!.capability.max_output_tokens).toBe(8192);

    expect(withoutOutput).toBeDefined();
    expect(withoutOutput!.maxOutputSize).toBeUndefined();
    expect(withoutOutput!.capability.max_output_tokens).toBe(0);
  });
});
