import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInitialAgentState, type AgentState } from '#/agent/core-effect';
import { deserializeAgentState, verifySnapshotHash } from '#/agent/snapshot/deserialize';
import { computeEpoch, shouldCreateSnapshot } from '#/agent/snapshot/epoch';
import { SnapshotPersistence } from '#/agent/snapshot/persistence';
import {
  computeSnapshotHash,
  createSnapshot,
  serializeAgentState,
} from '#/agent/snapshot/serialize';
import { CURRENT_SCHEMA_VERSION } from '#/agent/snapshot/types';
import { AutoSnapshotManager } from '#/agent/snapshot/auto-snapshot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<AgentState>): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Full lifecycle
// ---------------------------------------------------------------------------

describe('Integration: full lifecycle', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('createAgentState → createSnapshot → save → loadLatest → verifyHash → deserialize → compare all fields', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'integration-lifecycle-'));
    const persistence = new SnapshotPersistence(tmpDir);

    const original = makeState({
      phase: 'execution',
      turnCount: 150,
      tokenCount: 12000,
      logicalTick: 150,
      compacted: true,
      escapeAttempted: true,
      pendingSwarmParams: { strategy: 'fork-join', agents: 4 },
      usage: { inputOther: 500, output: 1000, inputCacheRead: 200, inputCacheCreation: 300 },
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'What about 3+3?' },
      ],
    });

    // Create snapshot from live state
    const snapshot = createSnapshot(original, 42);
    expect(snapshot.header.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    // Save to disk
    await persistence.save(snapshot);

    // Load from disk
    const loaded = await persistence.loadLatest();
    expect(loaded).not.toBeNull();

    // Verify hash integrity
    expect(verifySnapshotHash(loaded!)).toBe(true);
    expect(loaded!.header.sha256).toBe(snapshot.header.sha256);

    // Deserialize back to AgentState
    const restored = deserializeAgentState(loaded!.state);

    // Compare all fields
    expect(restored.phase).toBe(original.phase);
    expect(restored.turnCount).toBe(original.turnCount);
    expect(restored.tokenCount).toBe(original.tokenCount);
    expect(restored.logicalTick).toBe(original.logicalTick);
    expect(restored.compacted).toBe(original.compacted);
    expect(restored.escapeAttempted).toBe(original.escapeAttempted);
    expect(restored.pendingSwarmParams).toEqual(original.pendingSwarmParams);
    expect(restored.usage).toEqual(original.usage);
    expect(restored.messages).toEqual(original.messages);
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-epoch lifecycle
// ---------------------------------------------------------------------------

describe('Integration: multi-epoch lifecycle', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('create snapshots at turns 100, 200, 300 → loadLatest returns epoch 3 → prune to 2 → loadLatest returns epoch 3 (highest)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'integration-multi-epoch-'));
    const persistence = new SnapshotPersistence(tmpDir);

    // Create 3 snapshots at different epochs
    await persistence.save(createSnapshot(makeState({ turnCount: 100 }), 100));
    await persistence.save(createSnapshot(makeState({ turnCount: 200 }), 200));
    await persistence.save(createSnapshot(makeState({ turnCount: 300 }), 300));

    // Load latest → should be epoch 3 (turn 300)
    let loaded = await persistence.loadLatest();
    expect(loaded).not.toBeNull();
    expect(loaded!.header.epoch).toBe(3);
    expect(loaded!.state.turnCount).toBe(300);

    // All 3 epochs present
    let epochs = await persistence.listEpochs();
    expect(epochs).toEqual([1, 2, 3]);

    // Prune to keep only 2
    await persistence.prune(2);
    epochs = await persistence.listEpochs();
    expect(epochs).toEqual([2, 3]);

    // Load latest still returns epoch 3 (highest remaining)
    loaded = await persistence.loadLatest();
    expect(loaded).not.toBeNull();
    expect(loaded!.header.epoch).toBe(3);

    // Epoch 1 file should be gone, but epoch 2 and 3 still valid
    expect(verifySnapshotHash(loaded!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Hash integrity chain — tamper detection
// ---------------------------------------------------------------------------

describe('Integration: hash integrity chain', () => {
  it('tamper one field in the JSON file → verifySnapshotHash returns false', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'integration-tamper-'));
    try {
      const persistence = new SnapshotPersistence(tmpDir);
      const snapshot = createSnapshot(makeState({ turnCount: 100 }), 10);

      await persistence.save(snapshot);

      // Verify it's valid before tampering
      const loaded = await persistence.loadLatest();
      expect(verifySnapshotHash(loaded!)).toBe(true);

      // Tamper: rewrite the file with a modified turnCount
      const raw = JSON.parse(
        await readFile(join(tmpDir, 'snapshots', 'snapshot.epoch.1.json'), 'utf-8'),
      );
      raw.state.turnCount = 999;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(tmpDir, 'snapshots', 'snapshot.epoch.1.json'),
        JSON.stringify(raw),
        'utf-8',
      );

      // Reload and verify — hash should fail
      const tampered = await persistence.loadLatest();
      expect(tampered).not.toBeNull();
      expect(verifySnapshotHash(tampered!)).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Schema version in header
// ---------------------------------------------------------------------------

describe('Integration: schema version in header', () => {
  it('snapshot.header.schemaVersion === CURRENT_SCHEMA_VERSION (1)', () => {
    const snapshot = createSnapshot(makeState({ turnCount: 50 }), 0);
    expect(snapshot.header.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(snapshot.header.schemaVersion).toBe(1);
  });

  it('schema version survives full round-trip through persistence', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'integration-schema-'));
    try {
      const persistence = new SnapshotPersistence(tmpDir);
      const snapshot = createSnapshot(makeState({ turnCount: 200 }), 10);
      await persistence.save(snapshot);

      const loaded = await persistence.loadLatest();
      expect(loaded).not.toBeNull();
      expect(loaded!.header.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(loaded!.header.schemaVersion).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. AutoSnapshotManager integration with real persistence
// ---------------------------------------------------------------------------

describe('Integration: AutoSnapshotManager with real persistence', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('onTurnComplete 200 times → 2 snapshot files → drain → pruning', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'integration-auto-'));
    const persistence = new SnapshotPersistence(tmpDir);
    const manager = new AutoSnapshotManager(persistence, 3);

    // Simulate 200 turns, each incrementing the turn count
    for (let i = 1; i <= 200; i++) {
      manager.onTurnComplete(i, makeState({ turnCount: i }), i);
    }

    await manager.drain();

    // Should have 2 snapshots: epoch 1 (turn 100) and epoch 2 (turn 200)
    const epochs = await persistence.listEpochs();
    expect(epochs).toEqual([1, 2]);

    // Both should be valid
    const latest = await persistence.loadLatest();
    expect(latest).not.toBeNull();
    expect(verifySnapshotHash(latest!)).toBe(true);
    expect(latest!.header.epoch).toBe(2);
    expect(latest!.state.turnCount).toBe(200);
  });

  it('continues to epoch 300 → 3 snapshots, all hash-verified', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'integration-auto-300-'));
    const persistence = new SnapshotPersistence(tmpDir);
    const manager = new AutoSnapshotManager(persistence, 3);

    for (let i = 1; i <= 300; i++) {
      manager.onTurnComplete(i, makeState({ turnCount: i }), i);
    }

    await manager.drain();

    const epochs = await persistence.listEpochs();
    expect(epochs).toEqual([1, 2, 3]);

    // Load and verify each epoch
    for (const epoch of epochs) {
      const raw = await readFile(
        join(persistence.getSnapshotDir(), `snapshot.epoch.${epoch}.json`),
        'utf-8',
      );
      const snapshot = JSON.parse(raw);
      expect(verifySnapshotHash(snapshot)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Serialization determinism
// ---------------------------------------------------------------------------

describe('Integration: serialization determinism', () => {
  it('serialize same state 100 times → JSON.stringify result is identical every time', () => {
    const state = makeState({
      phase: 'execution',
      turnCount: 42,
      tokenCount: 8000,
      logicalTick: 99,
      compacted: true,
      escapeAttempted: false,
      pendingSwarmParams: { key: [1, 2, { nested: true }] },
      usage: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      messages: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'response' }],
    });

    const results: string[] = [];
    for (let i = 0; i < 100; i++) {
      const serialized = serializeAgentState(state);
      results.push(JSON.stringify(serialized));
    }

    // All 100 serializations must be byte-identical
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Hash determinism
// ---------------------------------------------------------------------------

describe('Integration: hash determinism', () => {
  it('computeSnapshotHash of same state 100 times → all hashes identical', () => {
    const state = makeState({
      phase: 'execution',
      turnCount: 200,
      tokenCount: 5000,
      usage: { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 },
    });

    const serialized = serializeAgentState(state);
    const hashes: string[] = [];
    for (let i = 0; i < 100; i++) {
      hashes.push(computeSnapshotHash(serialized));
    }

    const unique = new Set(hashes);
    expect(unique.size).toBe(1);
    // Verify format: 64-char hex
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 8. Round-trip with complex messages
// ---------------------------------------------------------------------------

describe('Integration: round-trip with complex messages', () => {
  it('state with nested objects, arrays, and strings → serialize → deserialize → deep equal', () => {
    const complexState = makeState({
      phase: 'execution',
      turnCount: 300,
      tokenCount: 50000,
      logicalTick: 300,
      compacted: false,
      escapeAttempted: false,
      pendingSwarmParams: {
        mode: 'hierarchical',
        agents: [
          { id: 'a1', role: 'researcher', tools: ['web-search', 'file-read'] },
          { id: 'a2', role: 'coder', tools: ['bash', 'edit'] },
        ],
        config: { maxDepth: 3, timeout: 60000 },
      },
      usage: { inputOther: 10000, output: 5000, inputCacheRead: 3000, inputCacheCreation: 2000 },
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Analyze this data:\n{ "items": [1, 2, 3] }' },
        {
          role: 'assistant',
          content: 'Here is my analysis',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          ],
        },
        { role: 'tool', content: 'file1.txt\nfile2.txt', tool_call_id: 'call_1' },
        { role: 'assistant', content: 'Found 2 files. Here is a detailed report with unicode: café ñ 日本語' },
      ],
    });

    const serialized = serializeAgentState(complexState);
    const restored = deserializeAgentState(serialized);

    expect(restored).toEqual(complexState);

    // Also verify via createSnapshot path
    const snapshot = createSnapshot(complexState, 50);
    expect(verifySnapshotHash(snapshot)).toBe(true);

    const restoredFromSnapshot = deserializeAgentState(snapshot.state);
    expect(restoredFromSnapshot).toEqual(complexState);
  });
});
