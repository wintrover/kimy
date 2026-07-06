/**
 * Contract injector — resolves the `{{contract}}` placeholder in swarm
 * prompt templates.
 *
 * An AgentContract is a structured string that describes what each
 * subagent should deliver: acceptance criteria, constraints, scope,
 * or any other orchestration-level agreement injected into every
 * subagent prompt at spawn time.
 */

/**
 * The placeholder that, when present in a prompt_template, is replaced
 * with the AgentContract content at subagent spawn time.
 */
export const CONTRACT_PLACEHOLDER = '{{contract}}';

/**
 * A contract that governs what each subagent in a swarm should deliver.
 * The content is injected verbatim into the prompt template.
 */
export interface AgentContract {
  /** The raw contract text injected into each subagent prompt. */
  readonly content: string;
}

/**
 * Resolve a prompt template by replacing the `{{contract}}` placeholder
 * with the given contract content.
 *
 * - If the template does not contain the placeholder, it is returned as-is.
 * - If the template contains the placeholder but `contract` is `undefined`,
 *   the placeholder is stripped (replaced with an empty string).
 * - Otherwise the placeholder is replaced with `contract.content`.
 */
export function resolveContractTemplate(
  template: string,
  contract?: AgentContract,
): string {
  if (!template.includes(CONTRACT_PLACEHOLDER)) return template;
  if (contract === undefined) {
    return template.split(CONTRACT_PLACEHOLDER).join('');
  }
  return template.split(CONTRACT_PLACEHOLDER).join(contract.content);
}
