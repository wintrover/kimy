import { describe, expect, it } from 'vitest';

import {
  validateSpec,
  and,
  not,
  or,
  var_,
  const_,
  implies,
  iff,
  xor,
  type Sketch,
} from '#/tools/synthesis/spec-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSketch(overrides: Partial<Sketch> = {}): Sketch {
  return {
    id: 'test',
    preconditions: [],
    postconditions: [],
    invariants: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateSpec', () => {
  describe('consistent specs', () => {
    it('empty spec is consistent', () => {
      const result = validateSpec(makeSketch());
      expect(result.consistent).toBe(true);
      expect(result.contradictions).toBeUndefined();
    });

    it('single variable is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:a', formula: var_('a') }],
        }),
      );
      expect(result.consistent).toBe(true);
    });

    it('conjunction of independent variables is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:a', formula: var_('a') }],
          postconditions: [{ id: 'post:b', formula: var_('b') }],
          invariants: [{ id: 'inv:c', formula: var_('c') }],
        }),
      );
      expect(result.consistent).toBe(true);
    });

    it('A ∨ ¬A is always consistent (tautology)', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:taut', formula: or(var_('a'), not(var_('a'))) }],
        }),
      );
      expect(result.consistent).toBe(true);
    });

    it('A → A is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:impl', formula: implies(var_('a'), var_('a')) }],
        }),
      );
      expect(result.consistent).toBe(true);
    });

    it('A ↔ A is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:iff', formula: iff(var_('a'), var_('a')) }],
        }),
      );
      expect(result.consistent).toBe(true);
    });

    it('A → B with A and B is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:impl', formula: implies(var_('a'), var_('b')) }],
          postconditions: [{ id: 'post:a', formula: var_('a') }, { id: 'post:b', formula: var_('b') }],
        }),
      );
      expect(result.consistent).toBe(true);
    });

    it('A ∧ (A → B) with B is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [
            { id: 'pre:a', formula: var_('a') },
            { id: 'pre:impl', formula: implies(var_('a'), var_('b')) },
          ],
          postconditions: [{ id: 'post:b', formula: var_('b') }],
        }),
      );
      expect(result.consistent).toBe(true);
    });
  });

  describe('contradictory specs', () => {
    it('A ∧ ¬A is contradictory', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:yes', formula: var_('x') }],
          postconditions: [{ id: 'post:no', formula: not(var_('x')) }],
        }),
      );
      expect(result.consistent).toBe(false);
      expect(result.contradictions).toBeDefined();
      expect(result.contradictions!.length).toBeGreaterThan(0);
    });

    it('(A → B) ∧ A ∧ ¬B is contradictory', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:impl', formula: implies(var_('a'), var_('b')) }],
          postconditions: [
            { id: 'post:a', formula: var_('a') },
            { id: 'post:not-b', formula: not(var_('b')) },
          ],
        }),
      );
      expect(result.consistent).toBe(false);
      expect(result.contradictions).toBeDefined();
    });

    it('A ∧ B ∧ ¬A is contradictory', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [
            { id: 'pre:a', formula: var_('a') },
            { id: 'pre:b', formula: var_('b') },
          ],
          postconditions: [{ id: 'post:not-a', formula: not(var_('a')) }],
        }),
      );
      expect(result.consistent).toBe(false);
    });

    it('single self-contradictory constraint', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:false', formula: const_(false) }],
        }),
      );
      expect(result.consistent).toBe(false);
    });
  });

  describe('memoKey', () => {
    it('same spec produces same memoKey', () => {
      const sketch = makeSketch({
        preconditions: [{ id: 'pre:a', formula: var_('a') }],
      });
      const a = validateSpec(sketch);
      const b = validateSpec(sketch);
      expect(a.memoKey).toBe(b.memoKey);
    });

    it('different specs produce different memoKeys', () => {
      const a = validateSpec(
        makeSketch({ preconditions: [{ id: 'pre:a', formula: var_('a') }] }),
      );
      const b = validateSpec(
        makeSketch({ preconditions: [{ id: 'pre:b', formula: var_('b') }] }),
      );
      expect(a.memoKey).not.toBe(b.memoKey);
    });

    it('key order does not affect memoKey', () => {
      const sketchA: Sketch = {
        id: 'test',
        preconditions: [{ id: 'pre:x', formula: var_('x') }],
        postconditions: [{ id: 'post:y', formula: var_('y') }],
        invariants: [],
      };
      const sketchB: Sketch = {
        id: 'test',
        invariants: [],
        postconditions: [{ id: 'post:y', formula: var_('y') }],
        preconditions: [{ id: 'pre:x', formula: var_('x') }],
      };
      expect(validateSpec(sketchA).memoKey).toBe(validateSpec(sketchB).memoKey);
    });
  });

  describe('rlimit', () => {
    it('reports steps used', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:a', formula: var_('a') }],
        }),
      );
      expect(result.rlimit).toBeGreaterThanOrEqual(0);
    });

    it('rlimit option is respected', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:yes', formula: var_('x') }],
          postconditions: [{ id: 'post:no', formula: not(var_('x')) }],
        }),
        50,
      );
      // With rlimit=50 the solver may or may not finish; steps should be capped.
      expect(result.rlimit).toBeLessThanOrEqual(51);
    });

    it('accepts options object', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:a', formula: var_('a') }],
        }),
        { rlimit: 1000, maxDepth: 128 },
      );
      expect(result.consistent).toBe(true);
    });
  });

  describe('formula constructors', () => {
    it('const_true is consistent', () => {
      const result = validateSpec(
        makeSketch({ preconditions: [{ id: 'pre:t', formula: const_(true) }] }),
      );
      expect(result.consistent).toBe(true);
    });

    it('xor is satisfiable', () => {
      const result = validateSpec(
        makeSketch({ preconditions: [{ id: 'pre:xor', formula: xor(var_('a'), var_('b')) }] }),
      );
      expect(result.consistent).toBe(true);
    });

    it('A ⊕ A is contradictory', () => {
      const result = validateSpec(
        makeSketch({ preconditions: [{ id: 'pre:xor', formula: xor(var_('a'), var_('a')) }] }),
      );
      expect(result.consistent).toBe(false);
    });

    it('deep nested and/or is consistent', () => {
      const result = validateSpec(
        makeSketch({
          preconditions: [
            {
              id: 'pre:deep',
              formula: or(
                and(var_('a'), var_('b')),
                and(not(var_('a')), var_('c')),
              ),
            },
          ],
        }),
      );
      expect(result.consistent).toBe(true);
    });
  });

  describe('assumptions and ensures', () => {
    it('assumptions participate in validation', () => {
      const result = validateSpec(
        makeSketch({
          assumptions: [{ id: 'assume:x', formula: var_('x') }],
          ensures: [{ id: 'ensure:not-x', formula: not(var_('x')) }],
        }),
      );
      expect(result.consistent).toBe(false);
    });

    it('assumptions that make spec consistent', () => {
      // (a → b) ∧ ¬b ∧ ¬a  is satisfiable: a=false, b=false.
      const result = validateSpec(
        makeSketch({
          preconditions: [{ id: 'pre:impl', formula: implies(var_('a'), var_('b')) }],
          postconditions: [{ id: 'post:not-b', formula: not(var_('b')) }],
          assumptions: [{ id: 'assume:not-a', formula: not(var_('a')) }],
        }),
      );
      expect(result.consistent).toBe(true);
    });
  });
});
