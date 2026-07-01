import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

/**
 * Check whether a model supports thinking based on its capabilities.
 * Returns true if the model has 'thinking' or 'always_thinking' capability,
 * or has adaptiveThinking enabled.
 */
export function isThinkingModel(
  modelId: string | undefined,
  availableModels: Record<string, ModelAlias>,
): boolean {
  if (!modelId) return false;
  const model = availableModels[modelId];
  if (!model) return false;
  const caps = model.capabilities ?? [];
  return caps.includes('thinking') || caps.includes('always_thinking') || model.adaptiveThinking === true;
}

/**
 * Resolve a valid subagent model from config, with fallback chain.
 * Priority: config.subagent_model → config.default_model → first available model → undefined
 */
export function resolveSubagentModel(
  configSubagentModel: string | undefined,
  configDefaultModel: string | undefined,
  availableModels: Record<string, ModelAlias>,
): string | undefined {
  const candidate = configSubagentModel ?? configDefaultModel;
  if (candidate && availableModels[candidate] !== undefined) {
    return candidate;
  }
  // Invalid or missing: fall back to first available model
  const keys = Object.keys(availableModels);
  return keys.length > 0 ? keys[0] : undefined;
}
