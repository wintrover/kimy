/**
 * Single source of truth for the effective fallback model.
 * Pure function — same inputs always produce the same output.
 *
 * Priority:
 *   1. Config-level subagentFallbackModel (explicit user intent)
 *   2. Batch-level context.fallbackModel (runtime injection)
 *   3. undefined (no fallback available)
 */
export function getEffectiveFallbackModel(
  configFallback: string | undefined,
  contextFallback: string | undefined,
): string | undefined {
  return configFallback?.trim() || contextFallback?.trim() || undefined;
}
