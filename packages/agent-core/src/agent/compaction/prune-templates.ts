/**
 * Provider-specific dummy text templates for tool_result schema compliance.
 * Used by hardPrune to replace content while preserving tool_call_id and role.
 */
const PRUNE_TEMPLATES: Record<string, string> = {
  // OpenAI: role: 'tool' + content: string
  openai: '[Pruned: tool result exceeded context limit. Original result was discarded to preserve context space.]',
  // Anthropic: tool_result block content
  anthropic: '[Pruned: tool result exceeded context limit. Original result was discarded to preserve context space.]',
  // Kimi: role: 'tool' + content: string
  kimi: '[Pruned: tool result exceeded context limit.]',
  // Google GenAI
  'google-genai': '[Pruned: tool result exceeded context limit.]',
  // OpenAI Responses
  'openai_responses': '[Pruned: tool result exceeded context limit.]',
  // Vertex AI
  vertexai: '[Pruned: tool result exceeded context limit.]',
};

export function getPruneTemplate(providerId: string): string {
  return PRUNE_TEMPLATES[providerId] ?? PRUNE_TEMPLATES['openai']!;
}
