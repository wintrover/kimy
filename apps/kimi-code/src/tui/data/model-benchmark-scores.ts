import mapping from './model-id-mapping.json';
import scoreData from './model-benchmark-scores.json';

/** NVIDIA NIM model alias → HF model ID mapping. */
export const MODEL_ID_MAPPING: Readonly<Record<string, string>> = mapping;

/** HF model ID → geometric mean benchmark score (0-1). */
export const MODEL_BENCHMARK_SCORES: Readonly<Record<string, number>> =
  scoreData.scores as Record<string, number>;

/** HF model ID → tier (1 = direct benchmark, 2 = proxy-anchored, 3 = param-estimated). */
export const MODEL_TIERS: Readonly<Record<string, number>> =
  ((scoreData as any).modelTiers as Record<string, number> | undefined) ?? {};

/** Model aliases to exclude from the list (non-LLM / purged models). */
export const PURGED_MODELS: Readonly<string[]> =
  ((scoreData as any).purgedModels as string[] | undefined) ?? [];

/** HF model ID → proxy source HF model ID (for Tier 2 proxy-anchored models). */
export const MODEL_PROXY_SOURCES: Readonly<Record<string, string>> =
  ((scoreData as any).proxySources as Record<string, string> | undefined) ?? {};

/** Metadata about when and how scores were generated. */
export const SCORE_METADATA = scoreData.metadata as Readonly<{
  generatedAt: string;
  source: string;
  version: string;
  tier1Count?: number;
  tier2Count?: number;
  tier3Count?: number;
  tier3Ceiling?: number;
  purgedCount?: number;
}>;
