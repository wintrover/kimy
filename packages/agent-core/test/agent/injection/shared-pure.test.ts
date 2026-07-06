import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ContractViolation } from '../../../src/agent/injection/violation-injector';
import type { Z3Violation } from '../../../src/agent/injection/z3-feedback-injector';
import type { SynthesisFeedback } from '../../../src/agent/injection/synthesis-feedback-injector';
import {
  renderSynthesisBlock,
  renderViolationBlock,
  renderZ3Block,
  shallowEqual,
} from '../../../src/agent/injection/shared-pure';

// ---------------------------------------------------------------------------
// shallowEqual
// ---------------------------------------------------------------------------

describe.concurrent('shallowEqual', () => {
  it('returns true for two empty arrays', () => {
    expect(shallowEqual([], [])).toBe(true);
  });

  it('returns true for same-length arrays with identical elements by reference', () => {
    const obj = { a: 1 };
    expect(shallowEqual([obj, 2], [obj, 2])).toBe(true);
  });

  it('returns false when elements differ by reference', () => {
    expect(shallowEqual([{ a: 1 }], [{ a: 1 }])).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(shallowEqual([1], [1, 2])).toBe(false);
    expect(shallowEqual([1, 2], [1])).toBe(false);
  });

  it('returns true when both arguments reference the same array', () => {
    const arr = [1, 'two', 3];
    expect(shallowEqual(arr, arr)).toBe(true);
  });

  it('returns false when one array is empty and the other is not', () => {
    expect(shallowEqual([], [1])).toBe(false);
    expect(shallowEqual([1], [])).toBe(false);
  });

  it('returns true for null and null', () => {
    expect(shallowEqual(null, null)).toBe(true);
  });

  it('returns true for undefined and undefined', () => {
    expect(shallowEqual(undefined, undefined)).toBe(true);
  });

  it('returns false for null and undefined', () => {
    expect(shallowEqual(null, undefined)).toBe(false);
  });

  it('returns false for undefined and null', () => {
    expect(shallowEqual(undefined, null)).toBe(false);
  });

  it('returns false when first argument is null and second is an array', () => {
    expect(shallowEqual(null, [1])).toBe(false);
  });

  it('returns false when first argument is an array and second is undefined', () => {
    expect(shallowEqual([1], undefined)).toBe(false);
  });

  it('returns false for nested-but-shallow-equal objects (different references)', () => {
    const a = [{ nested: true }];
    const b = [{ nested: true }];
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('returns true when referencing the same nested object', () => {
    const shared = { nested: true };
    expect(shallowEqual([shared], [shared])).toBe(true);
  });

  it('handles larger arrays correctly', () => {
    const items = [1, 2, 3, 4, 5];
    expect(shallowEqual(items, items)).toBe(true);
    expect(shallowEqual(items, [1, 2, 3, 4, 6])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PBT: shallowEqual never throws
// ---------------------------------------------------------------------------

describe.concurrent('shallowEqual — PBT safety', () => {
  it('never throws for arbitrary inputs and always returns a boolean', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.anything()),
        ),
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.anything()),
        ),
        (a, b) => {
          const result = shallowEqual(
            a as readonly unknown[] | null | undefined,
            b as readonly unknown[] | null | undefined,
          );
          expect(typeof result).toBe('boolean');
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// renderViolationBlock
// ---------------------------------------------------------------------------

describe.concurrent('renderViolationBlock', () => {
  const sample: ContractViolation[] = [
    {
      contractId: 'no-direct-agent-core-import',
      contractDescription: 'CLI must not import agent-core directly',
      location: 'src/cli/main.ts:10',
      fix: 'Use the SDK adapter instead',
    },
  ];

  it('renders a violation block with expected sections', () => {
    const result = renderViolationBlock(sample);
    expect(result).toContain('## Contract Violations');
    expect(result).toContain('### no-direct-agent-core-import');
    expect(result).toContain('**Contract:** CLI must not import agent-core directly');
    expect(result).toContain('**Location:** src/cli/main.ts:10');
    expect(result).toContain('**Fix:** Use the SDK adapter instead');
    expect(result).toContain('Please review and fix');
  });

  it('returns empty string for null', () => {
    expect(renderViolationBlock(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(renderViolationBlock(undefined)).toBe('');
  });

  it('renders multiple violations', () => {
    const multiple: ContractViolation[] = [
      { contractId: 'a', contractDescription: 'desc-a', location: 'loc-a', fix: 'fix-a' },
      { contractId: 'b', contractDescription: 'desc-b', location: 'loc-b', fix: 'fix-b' },
    ];
    const result = renderViolationBlock(multiple);
    expect(result).toContain('### a');
    expect(result).toContain('### b');
    expect(result).toContain('desc-a');
    expect(result).toContain('desc-b');
  });
});

// ---------------------------------------------------------------------------
// renderZ3Block
// ---------------------------------------------------------------------------

describe.concurrent('renderZ3Block', () => {
  const sample: Z3Violation[] = [
    {
      constraintId: 'no-state-leak',
      description: 'State must not escape its scope',
      proofFragment: '(declare-fun x () Int)\n(assert (< x 0))',
      severity: 'error',
    },
  ];

  it('renders a Z3 block with expected sections', () => {
    const result = renderZ3Block(sample);
    expect(result).toContain('## Z3 Formal Verification Failures');
    expect(result).toContain('### no-state-leak [ERROR]');
    expect(result).toContain('**Constraint:** State must not escape its scope');
    expect(result).toContain('**Proof Analysis:**');
    expect(result).toContain('(declare-fun x () Int)');
    expect(result).toContain('mathematically proven');
  });

  it('returns empty string for null', () => {
    expect(renderZ3Block(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(renderZ3Block(undefined)).toBe('');
  });

  it('renders [WARNING] for warning severity', () => {
    const warning: Z3Violation[] = [
      {
        constraintId: 'soft',
        description: 'Soft constraint',
        proofFragment: 'proof',
        severity: 'warning',
      },
    ];
    expect(renderZ3Block(warning)).toContain('### soft [WARNING]');
  });
});

// ---------------------------------------------------------------------------
// renderSynthesisBlock
// ---------------------------------------------------------------------------

describe.concurrent('renderSynthesisBlock', () => {
  const successSample: SynthesisFeedback[] = [
    {
      type: 'success',
      sketchId: 'sketch-1',
      message: 'All constraints satisfied',
      details: 'Verification passed',
    },
  ];

  const failureSample: SynthesisFeedback[] = [
    {
      type: 'failure',
      sketchId: 'sketch-2',
      message: 'Spec is contradictory',
      details: '(unsat core here)',
    },
  ];

  it('renders a success block with expected sections', () => {
    const result = renderSynthesisBlock(successSample);
    expect(result).toContain('## Sketch-Based Algebraic Synthesis Feedback');
    expect(result).toContain('### Sketch: sketch-1');
    expect(result).toContain('**Result:** Synthesis succeeded.');
    expect(result).toContain('**Summary:** All constraints satisfied');
    expect(result).toContain('**Verification Report:**');
    expect(result).toContain('Verification passed');
  });

  it('renders a failure block with expected sections', () => {
    const result = renderSynthesisBlock(failureSample);
    expect(result).toContain('### Sketch: sketch-2');
    expect(result).toContain('Synthesis failed');
    expect(result).toContain('**Analysis:** Spec is contradictory');
    expect(result).toContain('**Unsat Core:**');
    expect(result).toContain('(unsat core here)');
    expect(result).toContain('MUST revise the *specification*');
  });

  it('returns empty string for null', () => {
    expect(renderSynthesisBlock(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(renderSynthesisBlock(undefined)).toBe('');
  });

  it('renders success without details when details is absent', () => {
    const noDetails: SynthesisFeedback[] = [
      { type: 'success', sketchId: 's', message: 'ok' },
    ];
    const result = renderSynthesisBlock(noDetails);
    expect(result).toContain('Synthesis succeeded.');
    expect(result).not.toContain('Verification Report');
  });

  it('renders failure without unsat core when details is absent', () => {
    const noDetails: SynthesisFeedback[] = [
      { type: 'failure', sketchId: 's', message: 'bad' },
    ];
    const result = renderSynthesisBlock(noDetails);
    expect(result).toContain('Synthesis failed');
    expect(result).not.toContain('Unsat Core');
  });
});
