import { describe, expect, it } from 'vitest';

import { createInitialAgentState, type AgentState } from '#/agent/core-effect';
import { createSnapshot, serializeAgentState } from '#/agent/snapshot/serialize';
import { deserializeAgentState, verifySnapshotHash } from '#/agent/snapshot/deserialize';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<AgentState>): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

function makeComplexState(): AgentState {
  const messages: unknown[] = [];
  for (let i = 0; i < 50; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(200)}`,
    });
  }

  return makeState({
    phase: 'execution',
    turnCount: 500,
    tokenCount: 100000,
    logicalTick: 500,
    compacted: true,
    escapeAttempted: false,
    pendingSwarmParams: {
      mode: 'hierarchical',
      agents: Array.from({ length: 10 }, (_, i) => ({
        id: `agent-${i}`,
        role: 'worker',
        tools: ['bash', 'edit', 'read', 'write'],
      })),
    },
    usage: { inputOther: 50000, output: 25000, inputCacheRead: 15000, inputCacheCreation: 10000 },
    messages,
  });
}

// ---------------------------------------------------------------------------
// 1. Snapshot creation throughput
// ---------------------------------------------------------------------------

describe('Performance: snapshot creation throughput', () => {
  it('create 1000 snapshots in < 1 second', () => {
    const state = makeComplexState();
    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      createSnapshot(state, i);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// 2. Snapshot deserialization throughput
// ---------------------------------------------------------------------------

describe('Performance: snapshot deserialization throughput', () => {
  it('deserialize 1000 snapshots in < 1 second', () => {
    const state = makeComplexState();
    // Pre-create serialized snapshots
    const snapshots = Array.from({ length: 1000 }, () =>
      serializeAgentState(state),
    );

    const start = performance.now();

    for (const serialized of snapshots) {
      deserializeAgentState(serialized);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// 3. Hash computation throughput
// ---------------------------------------------------------------------------

describe('Performance: hash computation throughput', () => {
  it('compute 1000 hashes in < 500ms', () => {
    const state = makeComplexState();
    const serialized = serializeAgentState(state);

    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      verifySnapshotHash({
        header: {
          schemaVersion: 1,
          epoch: 5,
          logicalTick: 500,
          sha256: '', // will be recomputed
          wireRecordCount: 100,
          createdAt: Date.now(),
        },
        state: serialized,
      });
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 4. Full replay comparison — snapshot round-trip
// ---------------------------------------------------------------------------

describe('Performance: full replay comparison', () => {
  it('snapshot round-trip (create → serialize → deserialize) completes in < 10ms for typical state', () => {
    const state = makeState({
      phase: 'execution',
      turnCount: 200,
      tokenCount: 30000,
      logicalTick: 200,
      usage: { inputOther: 10000, output: 5000, inputCacheRead: 3000, inputCacheCreation: 2000 },
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'Help me with this task.' },
      ],
    });

    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      const snapshot = createSnapshot(state, 10);
      const restored = deserializeAgentState(snapshot.state);
      // Verify fields match
      if (restored.turnCount !== state.turnCount) throw new Error('mismatch');
    }

    const elapsed = performance.now() - start;
    // 100 round-trips should take < 10ms
    expect(elapsed).toBeLessThan(10);
  });
});
