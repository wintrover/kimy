import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoSnapshotManager } from '#/agent/snapshot/auto-snapshot';
import { createInitialAgentState } from '#/agent/core-effect';
import type { SnapshotPersistence } from '#/agent/snapshot/persistence';

function makeState(overrides: Partial<{ turnCount: number; logicalTick: number }> = {}) {
  return { ...createInitialAgentState(), ...overrides };
}

describe('AutoSnapshotManager', () => {
  let mockPersistence: SnapshotPersistence;
  let manager: AutoSnapshotManager;

  beforeEach(() => {
    mockPersistence = {
      save: vi.fn().mockResolvedValue(undefined),
      loadLatest: vi.fn().mockResolvedValue(null),
      listEpochs: vi.fn().mockResolvedValue([]),
      prune: vi.fn().mockResolvedValue(undefined),
      getSnapshotDir: vi.fn().mockReturnValue('/tmp/snapshots'),
    } as unknown as SnapshotPersistence;
    manager = new AutoSnapshotManager(mockPersistence, 3);
  });

  it('does nothing at turn 0', () => {
    const state = makeState({ turnCount: 0 });
    manager.onTurnComplete(0, state, 0);

    expect(mockPersistence.save).not.toHaveBeenCalled();
  });

  it('does nothing at turn 99 (not an epoch boundary)', () => {
    const state = makeState({ turnCount: 99 });
    manager.onTurnComplete(99, state, 50);

    expect(mockPersistence.save).not.toHaveBeenCalled();
  });

  it('creates snapshot at turn 100 (epoch boundary)', async () => {
    const state = makeState({ turnCount: 100 });
    manager.onTurnComplete(100, state, 100);

    // Wait for the async operation to complete
    await manager.drain();

    expect(mockPersistence.save).toHaveBeenCalledOnce();
    const savedSnapshot = vi.mocked(mockPersistence.save).mock.calls[0]![0];
    expect(savedSnapshot.header.epoch).toBe(1);
    expect(savedSnapshot.state.turnCount).toBe(100);
  });

  it('creates snapshot at turn 200', async () => {
    const state = makeState({ turnCount: 200 });
    manager.onTurnComplete(200, state, 200);

    await manager.drain();

    expect(mockPersistence.save).toHaveBeenCalledOnce();
    const savedSnapshot = vi.mocked(mockPersistence.save).mock.calls[0]![0];
    expect(savedSnapshot.header.epoch).toBe(2);
    expect(savedSnapshot.state.turnCount).toBe(200);
  });

  it('drain() waits for pending operations to complete', async () => {
    // Make save slow
    let resolveSave!: () => void;
    vi.mocked(mockPersistence.save).mockImplementation(
      () => new Promise<void>((resolve) => { resolveSave = resolve; }),
    );

    const state = makeState({ turnCount: 100 });
    manager.onTurnComplete(100, state, 100);

    // drain should not resolve yet
    let drained = false;
    const drainPromise = manager.drain().then(() => { drained = true; });

    // Give a microtask tick
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(false);

    // Unblock the save
    resolveSave();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('snapshot failure does not throw', async () => {
    vi.mocked(mockPersistence.save).mockRejectedValue(new Error('disk full'));

    const state = makeState({ turnCount: 100 });
    // Should not throw
    expect(() => manager.onTurnComplete(100, state, 100)).not.toThrow();

    // drain should also not throw
    await manager.drain();
  });

  it('prune is called after snapshot creation', async () => {
    const state = makeState({ turnCount: 100 });
    manager.onTurnComplete(100, state, 100);

    await manager.drain();

    expect(mockPersistence.prune).toHaveBeenCalledWith(3);
    // prune should be called after save
    const saveCallOrder = vi.mocked(mockPersistence.save).mock.invocationCallOrder[0]!;
    const pruneCallOrder = vi.mocked(mockPersistence.prune).mock.invocationCallOrder[0]!;
    expect(saveCallOrder).toBeLessThan(pruneCallOrder);
  });

  it('multiple rapid calls serialize correctly (no concurrent writes)', async () => {
    // Make save slow to verify serialization
    const saveOrder: number[] = [];
    vi.mocked(mockPersistence.save).mockImplementation(async (snapshot) => {
      // Simulate async work
      await new Promise((r) => setTimeout(r, 5));
      saveOrder.push(snapshot.header.epoch);
    });

    // Fire three epoch boundaries in rapid succession
    // Turn 100 → epoch 1, turn 200 → epoch 2, turn 300 → epoch 3
    // All are valid epoch boundaries, so all should be enqueued
    manager.onTurnComplete(100, makeState({ turnCount: 100 }), 100);
    manager.onTurnComplete(200, makeState({ turnCount: 200 }), 200);
    manager.onTurnComplete(300, makeState({ turnCount: 300 }), 300);

    await manager.drain();

    // All three should have been saved
    expect(mockPersistence.save).toHaveBeenCalledTimes(3);
    // They should be serialized (sequential), preserving epoch order
    expect(saveOrder).toEqual([1, 2, 3]);
  });
});
