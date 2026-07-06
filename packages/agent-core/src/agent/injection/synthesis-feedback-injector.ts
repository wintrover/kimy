import { DynamicInjector } from './injector';
import { renderSynthesisBlock, shallowEqual } from './shared-pure';

/**
 * Feedback produced by the Sketch-Based Algebraic Synthesis orchestrator.
 *
 * On **UNSAT** (specification is contradictory), the synthesizer cannot
 * produce any implementation — the agent must revise the *spec*, not the
 * code. On **success**, the synthesizer emits the verified code and a
 * verification report the agent should inspect before proceeding.
 */
export interface SynthesisFeedback {
  /** `'failure'` when the spec is contradictory (UNSAT); `'success'` otherwise. */
  readonly type: 'success' | 'failure';

  /** Identifier of the sketch that was synthesized. */
  readonly sketchId: string;

  /** Primary human-readable message explaining the result. */
  readonly message: string;

  /** Optional extended detail — unsat core for failures, verification report for successes. */
  readonly details?: string;
}

/**
 * Injects sketch-based algebraic synthesis feedback into the agent's context.
 *
 * The synthesizer pushes {@link SynthesisFeedback} entries after each
 * synthesis pass. The injector formats them as a system reminder so the
 * model sees the outcome and can self-correct. In the failure (UNSAT)
 * case the model must revise the *specification* only; it must not edit
 * code directly.
 *
 * Follows the same injection cadence as other `DynamicInjector` subclasses
 * — once per model step, deduped so the same feedback is not re-appended.
 */
export class SynthesisFeedbackInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'synthesis_feedback';

  private feedback: readonly SynthesisFeedback[] = [];

  /**
   * Replace the current set of synthesis feedback entries. Called by the
   * synthesis orchestrator after each synthesis pass.
   */
  setFeedback(feedback: readonly SynthesisFeedback[]): void {
    // Force re-injection when the feedback set changes.
    if (!shallowEqual(this.feedback, feedback)) {
      this.injectedAt = null;
    }
    this.feedback = feedback;
  }

  /**
   * Clear all recorded feedback (e.g. after the model resolves the issues
   * and re-synthesis succeeds).
   */
  clearFeedback(): void {
    if (this.feedback.length > 0) {
      this.injectedAt = null;
    }
    this.feedback = [];
  }

  protected override getInjection(): string | undefined {
    if (this.feedback.length === 0) return undefined;
    return renderSynthesisBlock(this.feedback);
  }
}


