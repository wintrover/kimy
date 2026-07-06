import type { GoalSnapshot } from '../goal';
import { DynamicInjector } from './injector';
import {
  buildBlockedNote,
  buildPausedNote,
  buildGoalReminder,
} from './goal-pure';

export {
  buildBlockedNote,
  buildPausedNote,
  buildGoalReminder,
  maxBudgetFraction,
  budgetBandGuidance,
  escapeUntrustedText,
  formatElapsed,
} from './goal-pure';

/**
 * Injects the current goal into the main agent's context once per turn, at the
 * continuation boundary (see `InjectionManager.injectGoal`), not per model step.
 * The objective is treated as user-provided task data wrapped in
 * `<untrusted_objective>` — it describes the work but does not override
 * higher-priority instructions (system/developer messages, tool schemas,
 * permission rules, host controls).
 *
 * This injector never enforces budgets; the goal driver (`TurnFlow.driveGoal`)
 * owns hard continuation stops.
 */
export class GoalInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'goal';

  protected override getInjection(): string | undefined {
    const store = this.agent.goal;
    const goal = store.getGoal().goal;
    if (goal === null) return undefined;
    // Three intensity levels by status:
    // - `active`: full reminder + budget guidance; the goal driver is running turns.
    // - `blocked`: a light, non-demanding note so the model stays aware of the
    //   (possibly just-edited) goal and can help unstick it if the user asks.
    // - `paused`: a light guardrail so the model knows the goal exists but must
    //   not work on it unless the user explicitly asks.
    // `complete` never reaches here (it clears the record).
    if (goal.status === 'active') return buildGoalReminder(goal);
    if (goal.status === 'blocked') return buildBlockedNote(goal);
    if (goal.status === 'paused') return buildPausedNote(goal);
    return undefined;
  }
}
