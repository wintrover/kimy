import type { ContractViolation } from './violation-injector';
import type { Z3Violation } from './z3-feedback-injector';
import type { SynthesisFeedback } from './synthesis-feedback-injector';

// ---------------------------------------------------------------------------
// shallowEqual — single shared copy (deduplicated from 3 files)
// ---------------------------------------------------------------------------

/**
 * Shallow, element-by-reference comparison of two readonly arrays.
 *
 * Total: never throws — returns `false` for null, undefined, or mismatched
 * lengths; element comparison is strict identity (`===`).
 *
 * Notably `null` and `undefined` are **not** considered equal:
 * `shallowEqual(null, undefined)` → `false`.
 */
export function shallowEqual(
  a: readonly unknown[] | null | undefined,
  b: readonly unknown[] | null | undefined,
): boolean {
  if (a === null || a === undefined) {
    // null !== undefined; only identical falsy sentinels are equal
    return a === b;
  }
  if (b === null || b === undefined) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Render helpers — extracted from individual injector files
// ---------------------------------------------------------------------------

/**
 * Render contract violations as a Markdown system-reminder block.
 *
 * Total: returns `''` when input is null/undefined.
 */
export function renderViolationBlock(
  violations: readonly ContractViolation[] | null | undefined,
): string {
  if (violations === null || violations === undefined) {
    return '';
  }
  const lines: string[] = [];
  lines.push('## Contract Violations');

  for (const v of violations) {
    lines.push('');
    lines.push('### ' + v.contractId);
    lines.push('**Contract:** ' + v.contractDescription);
    lines.push('**Location:** ' + v.location);
    lines.push('**Fix:** ' + v.fix);
  }

  lines.push('');
  lines.push(
    'Please review and fix the violations listed above before proceeding with other work. ' +
      'These are rules that must be satisfied for the codebase to remain consistent.',
  );

  return lines.join('\n');
}

/**
 * Render Z3 formal-verification failures as a Markdown system-reminder block.
 *
 * Total: returns `''` when input is null/undefined.
 */
export function renderZ3Block(
  violations: readonly Z3Violation[] | null | undefined,
): string {
  if (violations === null || violations === undefined) {
    return '';
  }
  const lines: string[] = [];
  lines.push('## Z3 Formal Verification Failures');

  for (const v of violations) {
    lines.push('');
    let severityTag: string;
    if (v.severity === 'error') {
      severityTag = '[ERROR]';
    } else {
      severityTag = '[WARNING]';
    }
    lines.push('### ' + v.constraintId + ' ' + severityTag);
    lines.push('**Constraint:** ' + v.description);
    lines.push('**Proof Analysis:**');
    lines.push('');
    lines.push('```');
    lines.push(v.proofFragment);
    lines.push('```');
  }

  lines.push('');
  lines.push(
    'Please review and fix the formal verification failures listed above ' +
      'before proceeding with other work. These violations have been mathematically ' +
      'proven by the Z3 SMT solver and represent real constraint conflicts that ' +
      'must be resolved.',
  );

  return lines.join('\n');
}

/**
 * Render sketch-based algebraic synthesis feedback as a Markdown system-reminder block.
 *
 * Total: returns `''` when input is null/undefined.
 */
export function renderSynthesisBlock(
  feedback: readonly SynthesisFeedback[] | null | undefined,
): string {
  if (feedback === null || feedback === undefined) {
    return '';
  }
  const lines: string[] = [];
  lines.push('## Sketch-Based Algebraic Synthesis Feedback');

  for (const f of feedback) {
    lines.push('');
    lines.push('### Sketch: ' + f.sketchId);

    if (f.type === 'failure') {
      lines.push('');
      lines.push(
        '**Result:** Synthesis failed — specification is contradictory (UNSAT).',
      );
      lines.push('');
      lines.push('**Analysis:** ' + f.message);

      if (f.details) {
        lines.push('');
        lines.push('**Unsat Core:**');
        lines.push('');
        lines.push('```');
        lines.push(f.details);
        lines.push('```');
      }

      lines.push('');
      lines.push(
        'You MUST revise the *specification* to resolve the contradiction above. ' +
          'Do NOT modify code directly — the synthesizer will re-generate ' +
          'implementation from the corrected spec.',
      );
    } else {
      lines.push('');
      lines.push('**Result:** Synthesis succeeded.');
      lines.push('');
      lines.push('**Summary:** ' + f.message);

      if (f.details) {
        lines.push('');
        lines.push('**Verification Report:**');
        lines.push('');
        lines.push('```');
        lines.push(f.details);
        lines.push('```');
      }
    }
  }

  return lines.join('\n');
}
