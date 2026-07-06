import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInitialAgentState, type AgentState } from '../../../src/agent/core-effect';
import { deserializeAgentState, verifySnapshotHash } from '../../../src/agent/snapshot/deserialize';
import { computeEpoch, shouldCreateSnapshot } from '../../../src/agent/snapshot/epoch';
import { SnapshotPersistence } from '../../../src/agent/snapshot/persistence';
import {
  computeSnapshotHash,
  createSnapshot,
  serializeAgentState,
} from '../../../src/agent/snapshot/serialize';
import { CURRENT_SCHEMA_VERSION } from '../../../src/agent/snapshot/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<AgentState>): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

// ---------------------------------------------------------------------------
// serializeAgentState — round-trip
// ---------------------------------------------------------------------------

describe('serializeAgentState', () => {
  it('round-trips through deserializeAgentState preserving all fields', () => {
    const state = makeState({
      phase: 'execution',
      turnCount: 42,
      tokenCount: 8000,
      logicalTick: 99,
      compacted: true,
      escapeAttempted: true,
      pendingSwarmParams: { foo: 'bar' },
      usage: { inputOther: 100, output: 200, inputCacheRead: 300, inputCacheCreation: 400 },
      messages: [{ role: 'user', content: 'hello' }],
    });

    const serialized = serializeAgentState(state);
    const restored = deserializeAgentState(serialized);

    expect(restored.phase).toBe(state.phase);
    expect(restored.turnCount).toBe(state.turnCount);
    expect(restored.tokenCount).toBe(state.tokenCount);
    expect(restored.logicalTick).toBe(state.logicalTick);
    expect(restored.compacted).toBe(state.compacted);
    expect(restored.escapeAttempted).toBe(state.escapeAttempted);
    expect(restored.pendingSwarmParams).toEqual(state.pendingSwarmParams);
    expect(restored.usage).toEqual(state.usage);
    expect(restored.messages).toEqual(state.messages);
  });

  it('produces distinct copies (no shared references)', () => {
    const state = makeState({
      usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
      messages: [{ a: 1 }],
    });

    const serialized = serializeAgentState(state);
    // Mutate the original — serialized should not change
    (state.usage as { inputOther: number }).inputOther = 999;
    (state.messages as unknown[]).push({ b: 2 });

    expect(serialized.usage.inputOther).toBe(1);
    expect(serialized.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeSnapshotHash — determinism & sensitivity
// ---------------------------------------------------------------------------

describe('computeSnapshotHash', () => {
  it('returns the same hash for identical inputs (determinism)', () => {
    const serialized = serializeAgentState(makeState());
    const hash1 = computeSnapshotHash(serialized);
    const hash2 = computeSnapshotHash(serialized);
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different inputs (sensitivity)', () => {
    const hashA = computeSnapshotHash(serializeAgentState(makeState()));
    const hashB = computeSnapshotHash(
      serializeAgentState(makeState({ turnCount: 1 })),
    );
    expect(hashA).not.toBe(hashB);
  });
});

// ---------------------------------------------------------------------------
// verifySnapshotHash
// ---------------------------------------------------------------------------

describe('verifySnapshotHash', () => {
  it('returns true for a valid snapshot', () => {
    const snapshot = createSnapshot(makeState(), 10);
    expect(verifySnapshotHash(snapshot)).toBe(true);
  });

  it('returns false when the state is tampered after hashing', () => {
    const snapshot = createSnapshot(makeState(), 10);
    // Tamper: modify a field in the serialized state
    const tampered = {
      ...snapshot,
      state: { ...snapshot.state, turnCount: snapshot.state.turnCount + 1 },
    };
    expect(verifySnapshotHash(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSnapshot
// ---------------------------------------------------------------------------

describe('createSnapshot', () => {
  it('produces a valid header with schemaVersion=1, correct epoch, and 64-char hex sha256', () => {
    const state = makeState({ turnCount: 250, logicalTick: 250 });
    const snapshot = createSnapshot(state, 42);

    expect(snapshot.header.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(snapshot.header.schemaVersion).toBe(1);
    expect(snapshot.header.epoch).toBe(2); // floor(250/100)
    expect(snapshot.header.logicalTick).toBe(250);
    expect(snapshot.header.wireRecordCount).toBe(42);
    expect(snapshot.header.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof snapshot.header.createdAt).toBe('number');
    expect(snapshot.header.createdAt).toBeGreaterThan(0);
  });

  it('serializes the state into the snapshot body', () => {
    const state = makeState({ turnCount: 50 });
    const snapshot = createSnapshot(state, 0);

    expect(snapshot.state.turnCount).toBe(50);
    expect(snapshot.state.phase).toBe('planning');
  });
});

// ---------------------------------------------------------------------------
// SnapshotPersistence
// ---------------------------------------------------------------------------

describe('SnapshotPersistence', () => {
  let tmpDir: string;
  let persistence: SnapshotPersistence;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('save and loadLatest round-trip', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
    persistence = new SnapshotPersistence(tmpDir);

    const snapshot = createSnapshot(makeState({ turnCount: 100 }), 5);
    await persistence.save(snapshot);

    const loaded = await persistence.loadLatest();
    expect(loaded).not.toBeNull();
    expect(loaded!.header.epoch).toBe(1);
    expect(loaded!.state.turnCount).toBe(100);
    expect(loaded!.header.sha256).toBe(snapshot.header.sha256);
  });

  it('listEpochs returns sorted ascending', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
    persistence = new SnapshotPersistence(tmpDir);

    await persistence.save(createSnapshot(makeState({ turnCount: 300 }), 0));
    await persistence.save(createSnapshot(makeState({ turnCount: 100 }), 0));
    await persistence.save(createSnapshot(makeState({ turnCount: 200 }), 0));

    const epochs = await persistence.listEpochs();
    expect(epochs).toEqual([1, 2, 3]);
  });

  it('prune keeps only last N epochs', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
    persistence = new SnapshotPersistence(tmpDir);

    await persistence.save(createSnapshot(makeState({ turnCount: 100 }), 0));
    await persistence.save(createSnapshot(makeState({ turnCount: 200 }), 0));
    await persistence.save(createSnapshot(makeState({ turnCount: 300 }), 0));
    await persistence.save(createSnapshot(makeState({ turnCount: 400 }), 0));

    await persistence.prune(2);

    const remaining = await persistence.listEpochs();
    expect(remaining).toEqual([3, 4]);
  });

  it('loadLatest returns null when empty', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
    persistence = new SnapshotPersistence(tmpDir);

    const loaded = await persistence.loadLatest();
    expect(loaded).toBeNull();
  });

  it('getSnapshotDir returns the correct path', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
    persistence = new SnapshotPersistence(tmpDir);

    expect(persistence.getSnapshotDir()).toBe(join(tmpDir, 'snapshots'));
  });
});

// ---------------------------------------------------------------------------
// computeEpoch
// ---------------------------------------------------------------------------

describe('computeEpoch', () => {
  it('0 → 0', () => expect(computeEpoch(0)).toBe(0));
  it('99 → 0', () => expect(computeEpoch(99)).toBe(0));
  it('100 → 1', () => expect(computeEpoch(100)).toBe(1));
  it('199 → 1', () => expect(computeEpoch(199)).toBe(1));
  it('200 → 2', () => expect(computeEpoch(200)).toBe(2));
});

// ---------------------------------------------------------------------------
// shouldCreateSnapshot
// ---------------------------------------------------------------------------

describe('shouldCreateSnapshot', () => {
  it('0 → false', () => expect(shouldCreateSnapshot(0)).toBe(false));
  it('99 → false', () => expect(shouldCreateSnapshot(99)).toBe(false));
  it('100 → true', () => expect(shouldCreateSnapshot(100)).toBe(true));
  it('200 → true', () => expect(shouldCreateSnapshot(200)).toBe(true));
});
