/**
 * Bidirectional deterministic context projection layer.
 *
 * DOWNSTREAM: Strips <system-reminder> blocks from tool result text
 *   for sub-agents (prevents orchestrator runtime state leakage).
 * UPSTREAM: Strips system-level patterns from sub-agent completion
 *   text before it enters the orchestrator's context (prevents
 *   sub-agent prompt/constraint contamination).
 *
 * SAFETY: Legitimate system-reminders are injected via
 * appendSystemReminder() directly into the context — never inside
 * tool result text. This filter only affects text that coincidentally
 * contains these tags (e.g., reading session wire logs).
 */
export class ContextProjection {
  constructor(private readonly agentType: 'main' | 'sub' | 'independent') {}

  /** DOWNSTREAM: sub-agent reads tool results. */
  projectToolResult(output: string): string {
    if (this.agentType !== 'sub') return output;
    return stripSystemReminders(output);
  }

  /** UPSTREAM: orchestrator receives sub-agent completion. */
  projectSubagentResult(output: string, sourceType: 'sub'): string {
    if (sourceType !== 'sub') return output;
    return sanitizeSubagentOutput(output);
  }
}

/** Blanket strip ALL <system-reminder> blocks. Content-agnostic. */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*\n?/gi, '');
}

/**
 * Strip system-level contamination from sub-agent output.
 * Removes:
 * - <system-reminder> blocks (sub-agent's own injected reminders)
 * - System prompt fragment patterns (role declarations, constraint blocks)
 */
function sanitizeSubagentOutput(text: string): string {
  return text
    // Strip any <system-reminder> blocks the sub-agent may have echoed
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*\n?/gi, '')
    // Strip sub-agent contract blocks (injected at spawn time)
    .replace(/<subagent_contract>[\s\S]*?<\/subagent_contract>\s*\n?/gi, '')
    // Strip system prompt fragments that leaked into output
    .replace(/You are Kimi Code CLI[\s\S]*?(?=\n\n[^\n]|\n# )/g, '')
    // Strip "You are now running as a subagent" declarations
    .replace(/You are now running as a subagent\.[^\n]*\n/g, '');
}
