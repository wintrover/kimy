import { DynamicInjector } from './injector';
import { renderZ3Block, shallowEqual } from './shared-pure';

/**
 * A single Z3-formally-verified constraint violation.
 *
 * Produced when the Z3 SMT solver finds the constraint set is satisfiable
 * (i.e. a violation exists) and returns an unsat core / proof fragment
 * explaining *why* the constraints conflict.
 */
export interface Z3Violation {
  /** Identifier of the violated constraint (e.g. "no-state-leak"). */
  readonly constraintId: string;
  /** Human-readable description of what the constraint enforces. */
  readonly description: string;
  /** Z3 unsat core or proof fragment explaining the violation. */
  readonly proofFragment: string;
  /** How severe the violation is. */
  readonly severity: 'error' | 'warning';
}

/**
 * Injects Z3 formal-verification failure analysis into the agent's context.
 *
 * When the Z3 solver detects a violation (SAT result on the negated goal),
 * the orchestrator pushes the unsat core analysis into this injector. The
 * injector formats the proof fragments as a system reminder so the model
 * can understand the mathematically-proven failure and self-correct.
 *
 * Violations are cleared once the solver re-validates successfully.
 *
 * Follows the same injection cadence as other `DynamicInjector` subclasses —
 * once per model step, deduped so the same violations are not re-appended.
 */
export class Z3FeedbackInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'z3_verification';

  private violations: readonly Z3Violation[] = [];

  /**
   * Replace the current set of Z3 violations. Called by the Z3 orchestrator
   * after each solver pass.
   */
  setViolations(violations: readonly Z3Violation[]): void {
    // Force re-injection when the violation set changes.
    if (!shallowEqual(this.violations, violations)) {
      this.injectedAt = null;
    }
    this.violations = violations;
  }

  /**
   * Clear all recorded violations (e.g. after the model fixes them and
   * re-verification passes).
   */
  clearViolations(): void {
    if (this.violations.length > 0) {
      this.injectedAt = null;
    }
    this.violations = [];
  }

  protected override getInjection(): string | undefined {
    if (this.violations.length === 0) return undefined;
    return renderZ3Block(this.violations);
  }
}


