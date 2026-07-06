import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock logger (source imports it) ─────────────────────────────────────────

vi.mock('#/logging/logger', () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Imports (logger mock must be hoisted above) ─────────────────────────────

import {
  Z3Verifier,
  computeMemoKey,
  verifyMutation,
} from '#/tools/hooks/z3-verifier';
import type {
  ProofCarryingMutation,
} from '#/tools/hooks/z3-verifier';
import type { AgentContract } from '#/tools/hooks/contract-validator';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeContract(overrides?: Partial<AgentContract>): AgentContract {
  return {
    id: 'test-contract',
    allowedEffects: [{ kind: 'file_read' }, { kind: 'file_write' }],
    prohibitedEffects: [{ kind: 'eval' }],
    ...overrides,
  };
}

function makeMutation(overrides?: Partial<ProofCarryingMutation>): ProofCarryingMutation {
  return {
    id: 'mutation-1',
    declaredEffects: ['file_read'],
    ...overrides,
  };
}

// ── Z3Verifier (synchronous) ────────────────────────────────────────────────

describe('Z3Verifier', () => {
  let verifier: Z3Verifier;

  beforeEach(() => {
    verifier = new Z3Verifier({ verifyRlimit: 5_000_000, synthesizeRlimit: 1_000_000 });
  });

  it('sync verify — all effects allowed → no violations', () => {
    // Assertions reference effects positively but never negate them.
    const assertions = [
      '(assert effect_file_read)',
      '(assert effect_file_write)',
    ];
    const result = verifier.verify(assertions, 1000);
    expect(result.satisfiable).toBe(true);
    expect(result.rlimitBound).toBe(1000);
  });

  it('sync verify — prohibited effect detected → violations returned', () => {
    // An effect appears both positively AND negated → detected as violation.
    const assertions = [
      '(assert effect_file_read)',
      '(assert (not effect_file_read))',
    ];
    const result = verifier.verify(assertions, 1000);
    expect(result.satisfiable).toBe(false);
  });

  it('sync verify — empty assertions → pass', () => {
    const result = verifier.verify([], 1000);
    expect(result.satisfiable).toBe(true);
    expect(result.rlimitUsed).toBeLessThanOrEqual(5_000_000);
  });

  it('sync synthesize → always returns { success: false, assignments: [] }', () => {
    const result = verifier.synthesize(['(assert true)'], ['hole1'], 1000);
    expect(result.success).toBe(false);
    expect(result.assignments).toEqual([]);
  });
});

// ── computeMemoKey ───────────────────────────────────────────────────────────

describe('computeMemoKey', () => {
  it('deterministic — same inputs → same key', () => {
    const contract = makeContract();
    const mutation = makeMutation();
    const k1 = computeMemoKey(contract, mutation, 1000);
    const k2 = computeMemoKey(contract, mutation, 1000);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different rlimit → different key', () => {
    const contract = makeContract();
    const mutation = makeMutation();
    const k1 = computeMemoKey(contract, mutation, 1000);
    const k2 = computeMemoKey(contract, mutation, 2000);
    expect(k1).not.toBe(k2);
  });

  it('different mutation id → different key', () => {
    const contract = makeContract();
    const k1 = computeMemoKey(contract, makeMutation({ id: 'm-a' }), 1000);
    const k2 = computeMemoKey(contract, makeMutation({ id: 'm-b' }), 1000);
    expect(k1).not.toBe(k2);
  });
});

// ── verifyMutation (async Z3 WASM) ─────────────────────────────────────────

// Check whether z3-solver is available; skip async tests if not.
let z3Available = true;
try {
  await import('z3-solver');
} catch {
  z3Available = false;
}

describe('verifyMutation', { skip: !z3Available ? 'z3-solver not available' : false }, () => {
  // Each test gets a fresh contract/mutation pair.  verifyMutation creates
  // its own Z3 Context + Solver internally, so contexts are isolated.

  it('allowed effects only → ok: true, no violated constraints', async () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }, { kind: 'file_write' }],
      prohibitedEffects: [],
    });
    const mutation = makeMutation({
      declaredEffects: ['file_read'],
    });

    // All declared effects are in the allowed list → fast path (no Z3 call).
    const result = await verifyMutation(contract, mutation, 1000);
    expect(result.ok).toBe(true);
    expect(result.violatedConstraints).toBeUndefined();
    expect(typeof result.memoKey).toBe('string');
  });

  it('prohibited effect included → Z3 path triggered, ok: true (invariants block violation)', async () => {
    // When a mutation declares a prohibited effect, the Z3 solver's contract
    // invariants (which assert `not effect_<kind>` for prohibited effects)
    // directly contradict the mutation's declared effect, making the solver
    // return UNSAT.  This means: "the contract invariants are sufficient to
    // prevent the violation."  The actual prohibition enforcement happens in
    // the orchestrator/contract-validator, not here.
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }],
      prohibitedEffects: [{ kind: 'eval' }],
    });
    const mutation = makeMutation({
      declaredEffects: ['file_read', 'eval'],
    });

    const result = await verifyMutation(contract, mutation, 10_000);
    expect(result.ok).toBe(true);
    // Z3 path was taken (not fast path), so memoKey is a proper hex string.
    expect(result.memoKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rlimit).toBe(10_000);
  });

  it('rlimit fixed → deterministic result', async () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }],
      prohibitedEffects: [{ kind: 'network' }],
    });
    const mutation = makeMutation({
      declaredEffects: ['file_read', 'network'],
    });
    const rlimit = 10_000;

    const r1 = await verifyMutation(contract, mutation, rlimit);
    const r2 = await verifyMutation(contract, mutation, rlimit);

    expect(r1.ok).toBe(r2.ok);
    expect(r1.memoKey).toBe(r2.memoKey);
    expect(r1.rlimit).toBe(r2.rlimit);
  });

  it('empty preconditions/postconditions → passes', async () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }, { kind: 'file_write' }],
      prohibitedEffects: [{ kind: 'eval' }],
    });
    const mutation = makeMutation({
      declaredEffects: ['file_read'],
      preconditions: [],
      postconditions: [],
    });

    const result = await verifyMutation(contract, mutation, 1000);
    expect(result.ok).toBe(true);
  });

  it('resource bounds with contradiction → UNSAT (ok: true)', async () => {
    // Declare an effect that is NOT in the allowed list (triggers Z3 path),
    // and add a precondition that directly contradicts the declared effect.
    // The solver must return UNSAT because the mutation asserts effect_exec=true
    // while the precondition asserts (not effect_exec).
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }],
      prohibitedEffects: [],
    });
    const mutation = makeMutation({
      declaredEffects: ['exec'], // not in allowedEffects → triggers Z3 path
      preconditions: ['(assert (not effect_exec))'],
    });

    // exec is not allowed → buildViolationCondition returns ['exec']
    // Solver sees: effect_exec (from mutation) + (not effect_exec) (from precondition)
    // → contradictory permanent assertions → UNSAT
    const result = await verifyMutation(contract, mutation, 10_000);
    expect(result.ok).toBe(true);
  });
});
