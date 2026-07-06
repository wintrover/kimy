import { describe, expect, it } from 'vitest';

import { createInitialAgentState, type AgentState } from '#/agent/core-effect';
import { deserializeAgentState, verifySnapshotHash } from '#/agent/snapshot/deserialize';
import { computeEpoch, shouldCreateSnapshot } from '#/agent/snapshot/epoch';
import { createSnapshot, serializeAgentState } from '#/agent/snapshot/serialize';
import { getTimestamp } from '#/agent/records/timestamp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<AgentState>): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Snapshot determinism — same state → same snapshot JSON (10 iterations)
// ---------------------------------------------------------------------------

describe('Determinism: snapshot determinism', () => {
  it('same AgentState → same snapshot JSON every time (10 iterations)', () => {
    const state = makeState({
      phase: 'execution',
      turnCount: 250,
      tokenCount: 15000,
      logicalTick: 250,
      compacted: true,
      escapeAttempted: false,
      pendingSwarmParams: { mode: 'parallel', agents: [1, 2, 3] },
      usage: { inputOther: 100, output: 200, inputCacheRead: 300, inputCacheCreation: 400 },
      messages: [{ role: 'user', content: 'determinism check' }],
    });

    const jsons: string[] = [];
    for (let i = 0; i < 10; i++) {
      const snapshot = createSnapshot(state, 10);
      // Exclude createdAt from comparison (it varies with wall-clock time)
      const comparable = {
        header: { ...snapshot.header, createdAt: 0 },
        state: snapshot.state,
      };
      jsons.push(JSON.stringify(comparable));
    }

    const unique = new Set(jsons);
    expect(unique.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Hash determinism — same snapshot → same SHA-256 (100 iterations)
// ---------------------------------------------------------------------------

describe('Determinism: hash determinism', () => {
  it('same snapshot → same SHA-256 every time (100 iterations)', () => {
    const state = makeState({
      turnCount: 500,
      usage: { inputOther: 50, output: 100, inputCacheRead: 150, inputCacheCreation: 200 },
    });
    const serialized = serializeAgentState(state);

    const hashes: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Recompute snapshot object each time to avoid memoization
      const snapshot = createSnapshot(state, 0);
      const verified = verifySnapshotHash(snapshot);
      expect(verified).toBe(true);
      hashes.push(snapshot.header.sha256);
    }

    const unique = new Set(hashes);
    expect(unique.size).toBe(1);
    // Verify it's a valid 64-char hex SHA-256
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 3. getTimestamp determinism during replay
// ---------------------------------------------------------------------------

describe('Determinism: getTimestamp during replay', () => {
  it('with restoring={time: 12345}, always returns 12345', () => {
    for (let i = 0; i < 100; i++) {
      expect(getTimestamp({ time: 12345 })).toBe(12345);
    }
  });

  it('with restoring={time: 0}, always returns 0', () => {
    for (let i = 0; i < 50; i++) {
      expect(getTimestamp({ time: 0 })).toBe(0);
    }
  });

  it('with restoring={time: -1}, always returns -1 (even unusual values)', () => {
    for (let i = 0; i < 50; i++) {
      expect(getTimestamp({ time: -1 })).toBe(-1);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. getTimestamp variability during live execution
// ---------------------------------------------------------------------------

describe('Determinism: getTimestamp during live', () => {
  it('with restoring=null, returns wall-clock time (varies between calls)', () => {
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      results.push(getTimestamp(null));
    }
    // All values should be positive
    for (const r of results) {
      expect(r).toBeGreaterThan(0);
    }
    // They should be reasonable (within a second of Date.now())
    const now = Date.now();
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(now - 1000);
      expect(r).toBeLessThanOrEqual(now + 1000);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Epoch computation determinism — 1000 random values
// ---------------------------------------------------------------------------

describe('Determinism: epoch computation', () => {
  it('for any turnCount, computeEpoch always returns the same result (1000 values)', () => {
    // Generate deterministic "random" values using a simple LCG
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };

    for (let i = 0; i < 1000; i++) {
      const turnCount = next();
      const epoch = computeEpoch(turnCount);
      // Recompute — must be identical
      expect(computeEpoch(turnCount)).toBe(epoch);
      // Verify the math: floor(turnCount / 100)
      expect(epoch).toBe(Math.floor(turnCount / 100));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. shouldCreateSnapshot determinism — boundary values (100 iterations each)
// ---------------------------------------------------------------------------

describe('Determinism: shouldCreateSnapshot', () => {
  it('boundary values always produce the same result (100 iterations each)', () => {
    const boundaryCases = [0, 50, 99, 100, 101, 150, 199, 200, 201, 300, 500, 999, 1000];

    for (const turnCount of boundaryCases) {
      const expected = shouldCreateSnapshot(turnCount);
      for (let i = 0; i < 100; i++) {
        expect(shouldCreateSnapshot(turnCount)).toBe(expected);
      }
    }
  });

  it('epoch boundaries (multiples of 100) always trigger', () => {
    for (let epoch = 1; epoch <= 100; epoch++) {
      const turnCount = epoch * 100;
      for (let i = 0; i < 10; i++) {
        expect(shouldCreateSnapshot(turnCount)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Full replay determinism — snapshot → deserialize → fields identical
// ---------------------------------------------------------------------------

describe('Determinism: full replay', () => {
  it('snapshot created from state A + 0 deltas → state A\' where A\' === A (all fields equal)', () => {
    const stateA = makeState({
      phase: 'execution',
      turnCount: 400,
      tokenCount: 30000,
      logicalTick: 400,
      compacted: true,
      escapeAttempted: true,
      pendingSwarmParams: { strategy: 'scatter-gather', depth: 2 },
      usage: { inputOther: 5000, output: 3000, inputCacheRead: 1000, inputCacheCreation: 500 },
      messages: [
        { role: 'system', content: 'You are an agent.' },
        { role: 'user', content: 'Do something complex.' },
        { role: 'assistant', content: 'Thinking...' },
      ],
    });

    // Create snapshot, then immediately deserialize (simulating replay with 0 deltas)
    const snapshot = createSnapshot(stateA, 0);
    const stateA_prime = deserializeAgentState(snapshot.state);

    // All fields must be exactly equal
    expect(stateA_prime.phase).toBe(stateA.phase);
    expect(stateA_prime.turnCount).toBe(stateA.turnCount);
    expect(stateA_prime.tokenCount).toBe(stateA.tokenCount);
    expect(stateA_prime.logicalTick).toBe(stateA.logicalTick);
    expect(stateA_prime.compacted).toBe(stateA.compacted);
    expect(stateA_prime.escapeAttempted).toBe(stateA.escapeAttempted);
    expect(stateA_prime.pendingSwarmParams).toEqual(stateA.pendingSwarmParams);
    expect(stateA_prime.usage).toEqual(stateA.usage);
    expect(stateA_prime.messages).toEqual(stateA.messages);

    // Full deep equality
    expect(stateA_prime).toEqual(stateA);

    // Hash verification passes (proves the serialization path is deterministic)
    expect(verifySnapshotHash(snapshot)).toBe(true);
  });
});
