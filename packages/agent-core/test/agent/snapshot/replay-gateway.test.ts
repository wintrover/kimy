import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTimestamp } from '../../../src/agent/records/timestamp';
import { ReplayGateway } from '../../../src/agent/snapshot/replay-gateway';
import { SnapshotPersistence } from '../../../src/agent/snapshot/persistence';
import {
  createSnapshot,
} from '../../../src/agent/snapshot/serialize';
import { createInitialAgentState } from '../../../src/agent/core-effect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState() {
  return { ...createInitialAgentState() };
}

function makeValidSnapshot() {
  return createSnapshot(makeState(), 10);
}

function makeMockRecords(replayResult?: { warning?: string }) {
  return {
    replay: vi.fn().mockResolvedValue(replayResult ?? {}),
  };
}

function makeMockPersistence(snapshot: ReturnType<typeof makeValidSnapshot> | null = null) {
  return {
    loadLatest: vi.fn().mockResolvedValue(snapshot),
    save: vi.fn(),
    listEpochs: vi.fn().mockResolvedValue([]),
    prune: vi.fn(),
    getSnapshotDir: vi.fn().mockReturnValue('/tmp/snapshots'),
  };
}

// ---------------------------------------------------------------------------
// getTimestamp
// ---------------------------------------------------------------------------

describe('getTimestamp', () => {
  it('returns restoring.time when restoring is set (deterministic replay)', () => {
    expect(getTimestamp({ time: 12345 })).toBe(12345);
  });

  it('returns restoring.time even when it is 0', () => {
    expect(getTimestamp({ time: 0 })).toBe(0);
  });

  it('returns a number when restoring is null (live execution)', () => {
    const result = getTimestamp(null);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('returns Date.now()-like value when restoring has no time', () => {
    const before = Date.now();
    const result = getTimestamp({});
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// ReplayGateway
// ---------------------------------------------------------------------------

describe('ReplayGateway', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns usedSnapshot: false when no snapshots exist', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-gw-test-'));
    const records = makeMockRecords();
    const persistence = makeMockPersistence(null);

    const gw = new ReplayGateway(
      records as never,
      persistence as never,
    );

    const result = await gw.replay();

    expect(result.usedSnapshot).toBe(false);
    expect(result.deltaCount).toBe(0);
    expect(result.snapshotEpoch).toBeUndefined();
    expect(records.replay).toHaveBeenCalledOnce();
  });

  it('returns usedSnapshot: true when valid snapshot exists', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-gw-test-'));
    const snapshot = makeValidSnapshot();
    const records = makeMockRecords();
    const persistence = makeMockPersistence(snapshot);

    const gw = new ReplayGateway(
      records as never,
      persistence as never,
    );

    const result = await gw.replay();

    expect(result.usedSnapshot).toBe(true);
    expect(result.snapshotEpoch).toBe(snapshot.header.epoch);
    expect(result.deltaCount).toBe(0);
    expect(records.replay).toHaveBeenCalledOnce();
  });

  it('returns usedSnapshot: false when hash is tampered', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-gw-test-'));
    const snapshot = makeValidSnapshot();
    // Tamper with the snapshot state
    const tampered = {
      ...snapshot,
      state: { ...snapshot.state, turnCount: snapshot.state.turnCount + 1 },
    };
    const records = makeMockRecords();
    const persistence = makeMockPersistence(tampered);

    const gw = new ReplayGateway(
      records as never,
      persistence as never,
    );

    const result = await gw.replay();

    expect(result.usedSnapshot).toBe(false);
    expect(result.deltaCount).toBe(0);
    expect(records.replay).toHaveBeenCalledOnce();
  });

  it('calls records.replay without forwarding gateway options', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-gw-test-'));
    const records = makeMockRecords();
    const persistence = makeMockPersistence(null);

    const gw = new ReplayGateway(
      records as never,
      persistence as never,
    );

    await gw.replay({ range: { start: 5, count: 10 } });

    expect(records.replay).toHaveBeenCalledWith();
  });

  it('forwards warning from records.replay', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-gw-test-'));
    const records = makeMockRecords({ warning: 'protocol version mismatch' });
    const persistence = makeMockPersistence(null);

    const gw = new ReplayGateway(
      records as never,
      persistence as never,
    );

    const result = await gw.replay();

    expect(result.warning).toBe('protocol version mismatch');
  });

  it('fallback to full replay preserves warning when snapshot hash is invalid', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'replay-gw-test-'));
    const snapshot = makeValidSnapshot();
    const tampered = {
      ...snapshot,
      state: { ...snapshot.state, turnCount: snapshot.state.turnCount + 1 },
    };
    const records = makeMockRecords({ warning: 'some warning' });
    const persistence = makeMockPersistence(tampered);

    const gw = new ReplayGateway(
      records as never,
      persistence as never,
    );

    const result = await gw.replay();

    expect(result.usedSnapshot).toBe(false);
    expect(result.warning).toBe('some warning');
  });
});
