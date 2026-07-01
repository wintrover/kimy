import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import {
  MODEL_BENCHMARK_SCORES,
  MODEL_ID_MAPPING,
  MODEL_PROXY_SOURCES,
  MODEL_TIERS,
  PURGED_MODELS,
} from '#/tui/data/model-benchmark-scores';

/** Build a case-insensitive lookup map from HF model IDs to scores. */
const SCORE_BY_LOWER: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const [id, score] of Object.entries(MODEL_BENCHMARK_SCORES)) {
    map.set(id.toLowerCase(), score);
  }
  return map;
})();

/** Build a lowercase set of purged model aliases for fast lookup. */
const PURGED_LOWER: ReadonlySet<string> = new Set(
  PURGED_MODELS.map((m) => m.toLowerCase()),
);

/** Find the original-case key in MODEL_BENCHMARK_SCORES for a lowercase match. */
function findOriginalKey(lower: string): string | undefined {
  for (const key of Object.keys(MODEL_BENCHMARK_SCORES)) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Returns true if the alias is in the purged (non-LLM) models list. */
export function isPurgedModel(alias: string): boolean {
  return PURGED_LOWER.has(alias.toLowerCase());
}

/**
 * Look up the benchmark score and tier for a model.
 *
 * Resolution order:
 * 1. Explicit mapping table (MODEL_ID_MAPPING[alias] → HF ID → score)
 * 2. Case-insensitive exact match on the alias itself against score keys
 * 3. Case-insensitive match on model.model field
 * 4. undefined (no score — model goes to the unsorted group)
 *
 * Returns undefined for purged models.
 */
export function lookupBenchmarkScore(
  alias: string,
  model: ModelAlias,
): { score: number; tier: number; proxySource?: string } | undefined {
  // Check purged first
  if (isPurgedModel(alias)) return undefined;

  // 1) Explicit mapping: alias → HF ID
  const mappedId = MODEL_ID_MAPPING[alias];
  if (mappedId !== undefined) {
    const score = MODEL_BENCHMARK_SCORES[mappedId];
    if (score !== undefined) {
      const proxySource = MODEL_PROXY_SOURCES[mappedId];
      return { score, tier: MODEL_TIERS[mappedId] ?? 1, ...(proxySource !== undefined ? { proxySource } : {}) };
    }
    const lower = SCORE_BY_LOWER.get(mappedId.toLowerCase());
    if (lower !== undefined) {
      const originalKey = findOriginalKey(mappedId.toLowerCase());
      const proxySource = originalKey !== undefined ? MODEL_PROXY_SOURCES[originalKey] : undefined;
      return { score: lower, tier: (originalKey !== undefined ? MODEL_TIERS[originalKey] : undefined) ?? 1, ...(proxySource !== undefined ? { proxySource } : {}) };
    }
  }

  // 2) Case-insensitive match on alias
  const aliasLower = SCORE_BY_LOWER.get(alias.toLowerCase());
  if (aliasLower !== undefined) {
    const originalKey = findOriginalKey(alias.toLowerCase());
    const proxySource = originalKey !== undefined ? MODEL_PROXY_SOURCES[originalKey] : undefined;
    return { score: aliasLower, tier: (originalKey !== undefined ? MODEL_TIERS[originalKey] : undefined) ?? 1, ...(proxySource !== undefined ? { proxySource } : {}) };
  }

  // 3) Case-insensitive match on model.model
  const modelId = model.model;
  if (modelId !== undefined) {
    const modelLower = SCORE_BY_LOWER.get(modelId.toLowerCase());
    if (modelLower !== undefined) {
      const originalKey = findOriginalKey(modelId.toLowerCase());
      const proxySource = originalKey !== undefined ? MODEL_PROXY_SOURCES[originalKey] : undefined;
      return { score: modelLower, tier: (originalKey !== undefined ? MODEL_TIERS[originalKey] : undefined) ?? 1, ...(proxySource !== undefined ? { proxySource } : {}) };
    }
  }

  return undefined;
}

/**
 * Sort model entries by benchmark score in descending order.
 * Models with scores appear first (highest to lowest).
 * Models without scores appear last, preserving their original insertion order.
 */
export function sortModelsByBenchmark(
  entries: [string, ModelAlias][],
): [string, ModelAlias][] {
  const scored: { entry: [string, ModelAlias]; score: number }[] = [];
  const unscored: [string, ModelAlias][] = [];

  for (const entry of entries) {
    const [alias, model] = entry;
    const result = lookupBenchmarkScore(alias, model);
    if (result !== undefined) {
      scored.push({ entry, score: result.score });
    } else {
      unscored.push(entry);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return [...scored.map((s) => s.entry), ...unscored];
}
