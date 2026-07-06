import { describe, expect, it } from 'vitest';

import {
  type InvariantGuard,
  type Invariant,
  type StateDescriptor,
  AGENT_PHASE_VARS,
  InvariantVerifier,
  agentPhaseInvariants,
  agentPhaseState,
} from './invariant-verifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createVerifier(): Promise<{
  verifier: InvariantVerifier;
  invariants: Invariant[];
}> {
  const v = new InvariantVerifier();
  v.declare(AGENT_PHASE_VARS);
  await v.init();
  const invariants = agentPhaseInvariants(v.context!);
  v.addInvariants(invariants);
  return { verifier: v, invariants };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.concurrent('InvariantVerifier', () => {
  // ── INV-1: phase ∈ {planning, execution} ──────────────────────────

  describe.concurrent('INV-1: phase ∈ {planning, execution}', () => {
    it('satisfies INV-1 for valid phase "planning"', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('planning', false),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).not.toContain('INV-1');
    });

    it('satisfies INV-1 for valid phase "execution"', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('execution', true),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).not.toContain('INV-1');
    });

    it('violates INV-1 for invalid phase value (encoded as 2)', async () => {
      const verifier = new InvariantVerifier();
      verifier.declare(AGENT_PHASE_VARS);
      await verifier.init();
      verifier.addInvariants(
        agentPhaseInvariants(verifier.context!)[0]!,
      ); // INV-1 only

      const invalidState: StateDescriptor = {
        variables: new Map(AGENT_PHASE_VARS),
        values: new Map([
          ['phase', '2'], // not 0 or 1
          ['hasSwarmParams', 'false'],
        ]),
      };
      const result = await verifier.verify(invalidState);
      expect(result.satisfied).toBe(false);
      expect(result.violations).toContain('INV-1');
    });
  });

  // ── INV-2: execution → pendingSwarmParams ≠ null ──────────────────

  describe.concurrent('INV-2: execution → hasSwarmParams', () => {
    it('satisfies INV-2 when execution with params', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('execution', true),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).not.toContain('INV-2');
    });

    it('violates INV-2 when execution without params', async () => {
      const verifier = new InvariantVerifier();
      verifier.declare(AGENT_PHASE_VARS);
      await verifier.init();
      verifier.addInvariants(
        agentPhaseInvariants(verifier.context!)[1]!,
      ); // INV-2 only

      const result = await verifier.verify(
        agentPhaseState('execution', false),
      );
      expect(result.satisfied).toBe(false);
      expect(result.violations).toContain('INV-2');
    });
  });

  // ── INV-3: planning → pendingSwarmParams = null ───────────────────

  describe.concurrent('INV-3: planning → !hasSwarmParams', () => {
    it('satisfies INV-3 when planning without params', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('planning', false),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).not.toContain('INV-3');
    });

    it('violates INV-3 when planning with params', async () => {
      const verifier = new InvariantVerifier();
      verifier.declare(AGENT_PHASE_VARS);
      await verifier.init();
      verifier.addInvariants(
        agentPhaseInvariants(verifier.context!)[2]!,
      ); // INV-3 only

      const result = await verifier.verify(
        agentPhaseState('planning', true),
      );
      expect(result.satisfied).toBe(false);
      expect(result.violations).toContain('INV-3');
    });
  });

  // ── All three invariants together ──────────────────────────────────

  describe.concurrent('all invariants combined', () => {
    it('satisfies all invariants for a valid planning state', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('planning', false),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('satisfies all invariants for a valid execution state', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('execution', true),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('reports all applicable violations for a doubly-invalid state', async () => {
      // execution without params violates INV-2; INV-1 and INV-3 are fine.
      const { verifier } = await createVerifier();
      const result = await verifier.verify(
        agentPhaseState('execution', false),
      );
      expect(result.satisfied).toBe(false);
      expect(result.violations).toContain('INV-2');
      expect(result.violations).not.toContain('INV-1');
      expect(result.violations).not.toContain('INV-3');
    });
  });

  // ── Transition verification ────────────────────────────────────────

  describe.concurrent('verifyTransition', () => {
    it('reports a valid transition from planning → execution', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verifyTransition(
        agentPhaseState('planning', false),
        agentPhaseState('execution', true),
      );
      expect(result.satisfied).toBe(true);
      expect(result.fromSatisfied).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('reports a valid transition from execution → planning', async () => {
      const { verifier } = await createVerifier();
      const result = await verifier.verifyTransition(
        agentPhaseState('execution', true),
        agentPhaseState('planning', false),
      );
      expect(result.satisfied).toBe(true);
      expect(result.fromSatisfied).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('detects an invalid transition that drops params mid-execution', async () => {
      const { verifier } = await createVerifier();
      // "from" is valid execution, "to" is execution without params → INV-2 violated.
      const result = await verifier.verifyTransition(
        agentPhaseState('execution', true),
        agentPhaseState('execution', false),
      );
      expect(result.satisfied).toBe(false);
      expect(result.fromSatisfied).toBe(true);
      expect(result.violations).toContain('INV-2');
    });
  });

  // ── reset ──────────────────────────────────────────────────────────

  describe.concurrent('reset', () => {
    it('clears invariants so nothing is verified', async () => {
      const { verifier } = await createVerifier();
      verifier.reset();
      // After reset, verify should succeed trivially (no invariants to check).
      const result = await verifier.verify(
        agentPhaseState('execution', false),
      );
      expect(result.satisfied).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// InvariantGuard tests
// ---------------------------------------------------------------------------

describe.concurrent('InvariantGuard', () => {
  interface PhaseState {
    phase: 'planning' | 'execution';
    hasSwarmParams: boolean;
  }

  const phaseGuard: InvariantGuard<PhaseState> = {
    validate(input: unknown) {
      if (typeof input !== 'object' || input === null) {
        return { valid: false, reason: 'input must be an object' };
      }
      const obj = input as Record<string, unknown>;
      const phase = obj['phase'];
      if (phase !== 'planning' && phase !== 'execution') {
        return { valid: false, reason: 'phase must be planning or execution' };
      }
      const hasSwarmParams = obj['hasSwarmParams'];
      if (typeof hasSwarmParams !== 'boolean') {
        return { valid: false, reason: 'hasSwarmParams must be boolean' };
      }
      // INV-2: execution → hasSwarmParams
      if (phase === 'execution' && !hasSwarmParams) {
        return {
          valid: false,
          reason: 'execution requires hasSwarmParams',
        };
      }
      // INV-3: planning → !hasSwarmParams
      if (phase === 'planning' && hasSwarmParams) {
        return {
          valid: false,
          reason: 'planning must not have hasSwarmParams',
        };
      }
      return { valid: true, data: { phase, hasSwarmParams } };
    },
  };

  it('accepts a valid planning state', () => {
    const result = phaseGuard.validate({ phase: 'planning', hasSwarmParams: false });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.phase).toBe('planning');
    }
  });

  it('accepts a valid execution state', () => {
    const result = phaseGuard.validate({ phase: 'execution', hasSwarmParams: true });
    expect(result.valid).toBe(true);
  });

  it('rejects execution without swarm params (INV-2)', () => {
    const result = phaseGuard.validate({ phase: 'execution', hasSwarmParams: false });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('execution requires hasSwarmParams');
    }
  });

  it('rejects planning with swarm params (INV-3)', () => {
    const result = phaseGuard.validate({ phase: 'planning', hasSwarmParams: true });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('planning must not have hasSwarmParams');
    }
  });

  it('rejects non-object input', () => {
    const result = phaseGuard.validate('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid phase value', () => {
    const result = phaseGuard.validate({ phase: 'idle', hasSwarmParams: false });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('planning or execution');
    }
  });
});
