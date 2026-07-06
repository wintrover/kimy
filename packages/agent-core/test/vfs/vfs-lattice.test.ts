import { describe, expect, it } from 'vitest';

import { VirtualFilesystem } from '#/vfs/virtual-filesystem';
import type { VfsEpoch } from '#/vfs/virtual-filesystem';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapSnapshot(epoch: VfsEpoch): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of epoch.files) {
    result[k] = v;
  }
  return result;
}

function expectEpochFiles(epoch: VfsEpoch, expected: Record<string, string>): void {
  expect(mapSnapshot(epoch)).toEqual(expected);
}

// ===========================================================================
// Commutativity — independent file writes
// ===========================================================================

describe('Commutativity — independent file writes', () => {
  it('1. two independent files in different order → same final epoch content', () => {
    const vfsA = new VirtualFilesystem();
    const e1a = vfsA.writeFile('a.ts', 'content A');
    const e2a = vfsA.writeFile('b.ts', 'content B');

    const vfsB = new VirtualFilesystem();
    const e1b = vfsB.writeFile('b.ts', 'content B');
    const e2b = vfsB.writeFile('a.ts', 'content A');

    expectEpochFiles(e2a, { 'a.ts': 'content A', 'b.ts': 'content B' });
    expectEpochFiles(e2b, { 'a.ts': 'content A', 'b.ts': 'content B' });
    expect(mapSnapshot(e2a)).toEqual(mapSnapshot(e2b));
  });

  it('2. three independent files — two different permutations yield same final content', () => {
    // Permutation A: x → y → z
    const vfsA = new VirtualFilesystem();
    vfsA.writeFile('x.ts', 'X');
    vfsA.writeFile('y.ts', 'Y');
    const epA = vfsA.writeFile('z.ts', 'Z');

    // Permutation B: z → x → y
    const vfsB = new VirtualFilesystem();
    vfsB.writeFile('z.ts', 'Z');
    vfsB.writeFile('x.ts', 'X');
    const epB = vfsB.writeFile('y.ts', 'Y');

    // Permutation C: y → z → x
    const vfsC = new VirtualFilesystem();
    vfsC.writeFile('y.ts', 'Y');
    vfsC.writeFile('z.ts', 'Z');
    const epC = vfsC.writeFile('x.ts', 'X');

    const expected = { 'x.ts': 'X', 'y.ts': 'Y', 'z.ts': 'Z' };
    expectEpochFiles(epA, expected);
    expectEpochFiles(epB, expected);
    expectEpochFiles(epC, expected);
  });
});

// ===========================================================================
// Idempotency
// ===========================================================================

describe('Idempotency', () => {
  it('3. double deleteFile on non-existent path → same state as single delete (no-op)', () => {
    const vfs = new VirtualFilesystem();
    const before = vfs.getActiveEpoch();

    // deleteFile on a non-existent path is a no-op
    const afterFirst = vfs.deleteFile('ghost.ts');
    expect(afterFirst.id).toBe(before.id);
    expect(afterFirst.files.size).toBe(0);

    const afterSecond = vfs.deleteFile('ghost.ts');
    expect(afterSecond.id).toBe(before.id);
    expect(afterSecond.files.size).toBe(0);

    // Still at epoch 0 — no new epochs were created
    expect(vfs.epochCount).toBe(1);
  });
});

// ===========================================================================
// Fixed-Point Uniqueness
// ===========================================================================

describe('Fixed-Point Uniqueness', () => {
  it('4. writing same content twice → different epochs but identical file content', () => {
    const vfs = new VirtualFilesystem();
    const ep1 = vfs.writeFile('a.ts', 'same content');
    const ep2 = vfs.writeFile('a.ts', 'same content');

    // Epochs are distinct
    expect(ep1.id).not.toBe(ep2.id);

    // Content is identical (fixed point)
    expect(ep1.files.get('a.ts')).toBe('same content');
    expect(ep2.files.get('a.ts')).toBe('same content');
    expectEpochFiles(ep1, { 'a.ts': 'same content' });
    expectEpochFiles(ep2, { 'a.ts': 'same content' });
  });

  it('5. epoch ID increments but content stabilizes at fixed point', () => {
    const vfs = new VirtualFilesystem();
    const ids: number[] = [];
    const contents: string[] = [];

    for (let i = 0; i < 5; i++) {
      const ep = vfs.writeFile('fixed.ts', 'immutable');
      ids.push(ep.id);
      contents.push(ep.files.get('fixed.ts')!);
    }

    // All IDs are strictly increasing
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    }

    // All contents are identical (fixed point)
    for (const c of contents) {
      expect(c).toBe('immutable');
    }
  });
});

// ===========================================================================
// Monad Laws
// ===========================================================================

describe('Monad Laws', () => {
  it('6. left identity — writeFile on a new VFS produces expected epoch', () => {
    // "return a >>= f" = "f a"
    // Creating a new VFS and writing is equivalent to writing on any fresh VFS
    const vfsA = new VirtualFilesystem();
    const epA = vfsA.writeFile('x.ts', 'hello');

    const vfsB = new VirtualFilesystem();
    const epB = vfsB.writeFile('x.ts', 'hello');

    expectEpochFiles(epA, { 'x.ts': 'hello' });
    expectEpochFiles(epB, { 'x.ts': 'hello' });
    expect(mapSnapshot(epA)).toEqual(mapSnapshot(epB));
  });

  it('7. right identity — writeFile then rollback restores original state', () => {
    // "m >>= return" = "m"
    const vfs = new VirtualFilesystem();
    const original = vfs.getActiveEpoch();

    vfs.writeFile('temp.ts', 'temporary content');
    const rolledBack = vfs.rollback();

    // Rolled back to the same epoch id
    expect(rolledBack.id).toBe(original.id);
    // Content is identical
    expectEpochFiles(rolledBack, mapSnapshot(original) as Record<string, string>);
    // File should not exist in the original state
    expect(rolledBack.files.has('temp.ts')).toBe(false);
  });

  it('8. associativity — (write A → write B) → write C = write A → (write B → write C)', () => {
    // Left grouping
    const vfsL = new VirtualFilesystem();
    const lA = vfsL.writeFile('a.ts', 'A');
    // A new epoch from writing A; then from that state write B and C
    vfsL.writeFile('b.ts', 'B');
    const lFinal = vfsL.writeFile('c.ts', 'C');

    // Right grouping — same sequence, just conceptual grouping
    const vfsR = new VirtualFilesystem();
    const rA = vfsR.writeFile('a.ts', 'A');
    vfsR.writeFile('b.ts', 'B');
    const rFinal = vfsR.writeFile('c.ts', 'C');

    // Both produce the same final content
    expectEpochFiles(lFinal, { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' });
    expectEpochFiles(rFinal, { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' });
    expect(mapSnapshot(lFinal)).toEqual(mapSnapshot(rFinal));

    // Intermediate epoch from writing A is also identical
    expectEpochFiles(lA, { 'a.ts': 'A' });
    expectEpochFiles(rA, { 'a.ts': 'A' });
  });
});

// ===========================================================================
// Immutability Enforcement
// ===========================================================================

describe('Immutability Enforcement', () => {
  it('9. shallow freeze — mutation attempt on Map does not affect VFS state (copy-on-write)', () => {
    const vfs = new VirtualFilesystem();
    vfs.writeFile('a.ts', 'content A');
    const epoch1 = vfs.getActiveEpoch();

    // Create epoch2 BEFORE mutation — this captures the snapshot.
    const epoch2 = vfs.writeFile('b.ts', 'content B');

    // Now mutate epoch1's Map after the copy was taken.
    // Object.freeze is shallow — Map.prototype.set still works on frozen Maps.
    // This is the key shallow-freeze limitation.
    const mutableMap = epoch1.files as Map<string, string>;
    mutableMap.set('malicious.ts', 'injected');

    // epoch1 IS affected (shallow freeze limitation)
    expect(epoch1.files.has('malicious.ts')).toBe(true);

    // But epoch2 must be unaffected — it was created via copy-on-write
    // from epoch1's state at the time of the copy.
    expect(epoch2.files.has('malicious.ts')).toBe(false);
    expect(epoch2.files.get('b.ts')).toBe('content B');
    expect(epoch2.files.get('a.ts')).toBe('content A');
  });

  it('10. epoch independence — mutating old epoch Map does not affect new epochs', () => {
    const vfs = new VirtualFilesystem();
    vfs.writeFile('a.ts', 'A');
    const epoch1 = vfs.getActiveEpoch();

    // Create epoch2 BEFORE mutating epoch1
    vfs.writeFile('b.ts', 'B');
    const epoch2 = vfs.getActiveEpoch();

    // Object.freeze on a Map is shallow — .set() still works on Map internals.
    // Mutate epoch1 AFTER epoch2 was created to test copy-on-write.
    const e1map = epoch1.files as Map<string, string>;
    e1map.set('injected.ts', 'bad');
    e1map.set('a.ts', 'MUTATED');

    // epoch1 is indeed affected (shallow freeze limitation)
    expect(epoch1.files.has('injected.ts')).toBe(true);
    expect(epoch1.files.get('a.ts')).toBe('MUTATED');

    // But epoch2 must be unaffected — copy-on-write guarantee.
    // epoch2 was built from a snapshot before the mutation.
    expect(epoch2.files.has('injected.ts')).toBe(false);
    expect(epoch2.files.get('a.ts')).toBe('A');
    expect(epoch2.files.get('b.ts')).toBe('B');
  });

  it('11. shallow freeze on epoch — epoch.frozen is true but Object.freeze is only on files Map', () => {
    const vfs = new VirtualFilesystem();
    vfs.writeFile('a.ts', 'A');
    const epoch = vfs.getActiveEpoch();

    // epoch.frozen is a runtime flag set to true
    expect(epoch.frozen).toBe(true);

    // The epoch object itself is NOT frozen — Object.freeze is only applied
    // to the files Map inside _createEpoch, not to the epoch wrapper.
    expect(Object.isFrozen(epoch)).toBe(false);

    // Create ep2 BEFORE mutating epoch's files, to test copy-on-write isolation.
    const ep2 = vfs.writeFile('b.ts', 'B');

    // The files Map IS passed through Object.freeze, but on a Map,
    // Object.freeze only freezes the object's own properties,
    // not the internal [[MapData]] — so .set() still works (shallow freeze).
    // This is the key shallow-freeze limitation: the Map's entries remain mutable.
    const filesMap = epoch.files as Map<string, string>;
    filesMap.set('extra.ts', 'oops');
    expect(epoch.files.get('extra.ts')).toBe('oops'); // mutation succeeded

    // The copy-on-write guarantee still protects future epochs:
    expect(ep2.files.has('extra.ts')).toBe(false);
    expect(ep2.files.get('a.ts')).toBe('A');
    expect(ep2.files.get('b.ts')).toBe('B');
  });
});

// ===========================================================================
// Monotonicity
// ===========================================================================

describe('Monotonicity', () => {
  it('12. epoch IDs strictly increase across writes', () => {
    const vfs = new VirtualFilesystem();
    const e0 = vfs.getActiveEpoch();
    const e1 = vfs.writeFile('a.ts', 'A');
    const e2 = vfs.writeFile('b.ts', 'B');
    const e3 = vfs.writeFile('c.ts', 'C');

    expect(e0.id).toBe(0);
    expect(e1.id).toBeGreaterThan(e0.id);
    expect(e2.id).toBeGreaterThan(e1.id);
    expect(e3.id).toBeGreaterThan(e2.id);
  });

  it('13. epochCount always >= activeEpochId + 1', () => {
    const vfs = new VirtualFilesystem();
    for (let i = 0; i < 10; i++) {
      vfs.writeFile(`f${i}.ts`, `content ${i}`);
      expect(vfs.epochCount).toBeGreaterThanOrEqual(vfs.activeEpochId + 1);
    }
  });
});

// ===========================================================================
// Rollback
// ===========================================================================

describe('Rollback', () => {
  it('14. rollback restores previous epoch content exactly', () => {
    const vfs = new VirtualFilesystem();
    vfs.writeFile('a.ts', 'alpha');
    const ep1 = vfs.getActiveEpoch();

    vfs.writeFile('b.ts', 'beta');
    expect(vfs.getFile('a.ts')).toBe('alpha');
    expect(vfs.getFile('b.ts')).toBe('beta');

    const rolledBack = vfs.rollback();
    expect(rolledBack.id).toBe(ep1.id);
    expectEpochFiles(rolledBack, { 'a.ts': 'alpha' });
    expect(vfs.getFile('b.ts')).toBeUndefined();
  });

  it('15. rollbackTo specific epoch ID → correct content', () => {
    const vfs = new VirtualFilesystem();
    const ep0 = vfs.getActiveEpoch(); // empty
    vfs.writeFile('a.ts', 'A');
    vfs.writeFile('b.ts', 'B');
    const ep2 = vfs.getActiveEpoch();
    vfs.writeFile('c.ts', 'C');

    // Rollback to epoch 1 (after writing a.ts)
    const rolledTo1 = vfs.rollbackTo(1);
    expect(rolledTo1.id).toBe(1);
    expectEpochFiles(rolledTo1, { 'a.ts': 'A' });

    // Rollback to epoch 0 (empty seed)
    const rolledTo0 = vfs.rollbackTo(0);
    expect(rolledTo0.id).toBe(0);
    expect(rolledTo0.files.size).toBe(0);

    // Rollback to epoch 2
    const rolledTo2 = vfs.rollbackTo(2);
    expect(rolledTo2.id).toBe(ep2.id);
    expectEpochFiles(rolledTo2, { 'a.ts': 'A', 'b.ts': 'B' });
  });

  it('16. rollback then forward write → new epoch based on rolled-back state', () => {
    const vfs = new VirtualFilesystem();
    vfs.writeFile('a.ts', 'A');
    vfs.writeFile('b.ts', 'B');

    // Rollback to epoch 1 (only a.ts)
    vfs.rollbackTo(1);
    expect(vfs.getFile('a.ts')).toBe('A');
    expect(vfs.getFile('b.ts')).toBeUndefined();

    // Write new file from rolled-back state
    const epNew = vfs.writeFile('c.ts', 'C');

    expectEpochFiles(epNew, { 'a.ts': 'A', 'c.ts': 'C' });
    expect(epNew.files.has('b.ts')).toBe(false);
    expect(vfs.getFile('b.ts')).toBeUndefined();
    expect(vfs.getFile('c.ts')).toBe('C');
  });
});
