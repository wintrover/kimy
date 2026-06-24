/**
 * PlanModeTurnStopPolicy — guards against plan mode zombie states.
 *
 * When the LLM ends its turn with `end_turn` (no tool calls) while plan
 * mode is active, this policy intervenes:
 *
 * 1. First failure: injects a reminder for the model to call ExitPlanMode.
 * 2. Second failure (deterministic fallback): forces `planMode.exit()`
 *    and emits a system reminder, returning the session to normal mode.
 *
 * The continuation counter is per-Agent-instance (Agent is Stateful —
 * one instance per session), so cross-session leakage is impossible.
 */

import type { Agent } from '#/agent';
import type {
  TurnStopPolicy,
  TurnStopPolicyContext,
  TurnStopPolicyResult,
} from '#/session/turn-stop-policy';

/** Tool names that constitute a valid plan-mode exit. */
const PLAN_MODE_EXIT_TOOLS: ReadonlySet<string> = new Set([
  'ExitPlanMode',
  'AskUserQuestion',
]);

export class PlanModeTurnStopPolicy implements TurnStopPolicy {
  readonly name = 'plan_mode_guard';

  private continuationCount = 0;

  constructor(private readonly agent: Agent) {}

  evaluate(ctx: TurnStopPolicyContext): TurnStopPolicyResult | undefined {
    // Not in plan mode — pass through and reset counter.
    if (!this.agent.planMode.isActive) {
      this.continuationCount = 0;
      return undefined;
    }

    // Check if any tool call name matches a required plan-mode exit tool.
    let foundRequired = false;
    for (const name of ctx.toolCallNames) {
      if (PLAN_MODE_EXIT_TOOLS.has(name)) {
        foundRequired = true;
        break;
      }
    }

    if (foundRequired) {
      this.continuationCount = 0;
      return undefined; // Valid plan mode exit — pass through.
    }

    // First failure: inject a prompt asking the model to retry.
    if (this.continuationCount < 1) {
      this.continuationCount++;
      return {
        continue: true,
        message:
          'Your turn ended without calling ExitPlanMode or AskUserQuestion. ' +
          'You MUST call ExitPlanMode now to present your plan for user approval, ' +
          'or call AskUserQuestion if you need clarification first. ' +
          'Do NOT end your turn with text only.',
      };
    }

    // Second failure: deterministic fallback — force exit plan mode.
    this.continuationCount = 0;

    this.agent.planMode.exit();

    this.agent.context.appendSystemReminder(
      '⚠️ Plan mode was automatically exited because the model failed to call ' +
        'ExitPlanMode after two consecutive attempts. The session has returned ' +
        'to normal mode. Any partial plan content has been preserved in the plan file.',
      { kind: 'system_trigger', name: 'plan_mode_force_exit' },
    );

    return { continue: false };
  }
}
