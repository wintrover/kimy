import { DynamicInjector } from './injector';
import { renderViolationBlock, shallowEqual } from './shared-pure';

/**
 * A single contract violation detected by the contract validator (S9).
 */
export interface ContractViolation {
  /** Which contract was violated (e.g. "no-direct-agent-core-import"). */
  readonly contractId: string;
  /** Human-readable description of the contract. */
  readonly contractDescription: string;
  /** Where in the code the violation was found (file path + line). */
  readonly location: string;
  /** What needs to change to satisfy the contract. */
  readonly fix: string;
}

/**
 * Injects detected contract violations into the agent's system prompt context.
 *
 * The contract validator (S9) pushes violations into this injector; the
 * injector formats them as a system reminder so the model sees the violations
 * and can self-correct. Violations are cleared once the validator reports
 * them as resolved.
 *
 * Follows the same injection cadence as other `DynamicInjector` subclasses —
 * once per model step, deduped so the same violations are not re-appended.
 */
export class ViolationInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'contract_violation';

  private violations: readonly ContractViolation[] = [];

  /**
   * Replace the current set of violations. Called by the contract validator
   * (S9) after each validation pass.
   */
  setViolations(violations: readonly ContractViolation[]): void {
    // Force re-injection when the violation set changes.
    if (!shallowEqual(this.violations, violations)) {
      this.injectedAt = null;
    }
    this.violations = violations;
  }

  /**
   * Clear all recorded violations (e.g. after the model fixes them).
   */
  clearViolations(): void {
    if (this.violations.length > 0) {
      this.injectedAt = null;
    }
    this.violations = [];
  }

  protected override getInjection(): string | undefined {
    if (this.violations.length === 0) return undefined;
    return renderViolationBlock(this.violations);
  }
}


