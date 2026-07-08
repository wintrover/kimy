import { describe, it, expect } from 'vitest';

import type { Kaos } from '../src/kaos';
import { ContentAddressedPool } from '../src/object-pool';
import { MerkleFileIndex, matchGlob } from '../src/merkle-file-index';
import { GenerationGarbageCollector } from '../src/generation-gc';
import { IndexedKaos } from '../src/indexed-kaos';
import { HermeticKaos } from '../src/hermetic-kaos';
import { IndexedSessionInitializer } from '../src/indexed-session-initializer';
import { MutationLog, DeterministicReducer } from '../../agent-core/src/agent/mutation-log';
import type { MutationOp, FileConflict } from '../../agent-core/src/agent/mutation-log';

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Minimal mock Kaos for unit tests that need path ops only.
 * File I/O is NOT needed because IndexedKaos reads from the index,
 * not the delegate.
 */
function createMockDelegate(): Kaos {
  return {
    name: 'mock-delegate',
    osEnv: undefined as unknown as Kaos['osEnv'],
    pathClass: () => 'posix' as const,
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => '/workspace',
    chdir: async () => {},
    withCwd: () => mockDelegate,
    withEnv: () => mockDelegate,
    stat: async () => ({ stMode: 0o100644, stIno: 0, stDev: 0, stNlink: 1, stUid: 0, stGid: 0, stSize: 0, stAtime: 0, stMtime: 0, stCtime: 0 }),
    iterdir: async function* () {},
    glob: async function* () {},
    readBytes: async () => Buffer.alloc(0),
    readText: async () => '',
    readLines: async function* () {},
    writeBytes: async () => 0,
    writeText: async () => 0,
    mkdir: async () => {},
    snapshot: async () => Object.freeze([]),
    exec: async () => { throw new Error('not implemented'); },
    execWithEnv: async () => { throw new Error('not implemented'); },
  };
}

const mockDelegate = createMockDelegate();

// ── ContentAddressedPool ─────────────────────────────────────────────

describe('ContentAddressedPool', () => {
  it('deduplicates identical content', () => {
    const pool = new ContentAddressedPool();
    const hash1 = pool.put(Buffer.from('hello'));
    const hash2 = pool.put(Buffer.from('hello'));
    expect(hash1).toBe(hash2);
    expect(pool.stats().objectCount).toBe(1);
  });

  it('stores different content separately', () => {
    const pool = new ContentAddressedPool();
    const hash1 = pool.put(Buffer.from('hello'));
    const hash2 = pool.put(Buffer.from('world'));
    expect(hash1).not.toBe(hash2);
    expect(pool.stats().objectCount).toBe(2);
  });

  it('retrieves content by hash', () => {
    const pool = new ContentAddressedPool();
    const content = Buffer.from('test content');
    const hash = pool.put(content);
    expect(pool.get(hash)?.toString()).toBe('test content');
  });
});

// ── MerkleFileIndex ──────────────────────────────────────────────────

describe('MerkleFileIndex', () => {
  it('creates empty index with deterministic root hash', () => {
    const index = MerkleFileIndex.empty();
    expect(index.rootHash).toBeDefined();
    expect(index.rootHash.length).toBe(64); // SHA-256 hex
  });

  it('writeFile updates root hash', () => {
    const index = MerkleFileIndex.empty();
    const hashBefore = index.rootHash;
    index.writeFile('test.txt', 'hello world');
    expect(index.rootHash).not.toBe(hashBefore);
  });

  it('deleteFile restores previous root hash', () => {
    const index = MerkleFileIndex.empty();
    const hashBefore = index.rootHash;
    index.writeFile('test.txt', 'hello');
    index.deleteFile('test.txt');
    // After deleting the only file, root should be back to empty
    expect(index.rootHash).toBe(hashBefore);
  });

  it('glob matches files in memory', async () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('src/a.ts', 'a');
    index.writeFile('src/b.ts', 'b');
    index.writeFile('test/c.ts', 'c');

    const results: string[] = [];
    for await (const f of index.glob('src/*.ts')) {
      results.push(f);
    }
    expect(results.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('branch creates lightweight snapshot', () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('a.txt', 'content');
    const snapshot = index.branch();

    expect(snapshot.rootHash).toBe(index.rootHash);
    expect(snapshot.files.size).toBe(1);
  });

  it('diff detects changes between snapshots', () => {
    const index = MerkleFileIndex.empty();
    const before = index.branch();

    index.writeFile('new.txt', 'new');
    index.writeFile('a.txt', 'a');
    const after = index.branch();

    const changes = MerkleFileIndex.diff(before, after);
    expect(changes.length).toBe(2);
    expect(changes.every(c => c.type === 'added')).toBe(true);
  });
});

// ── matchGlob ────────────────────────────────────────────────────────

describe('matchGlob', () => {
  it('matches single wildcard', () => {
    expect(matchGlob('*.ts', 'file.ts')).toBe(true);
    expect(matchGlob('*.ts', 'file.js')).toBe(false);
  });

  it('matches doublestar', () => {
    expect(matchGlob('**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'src/deep/b.ts')).toBe(true);
  });

  it('matches question mark', () => {
    expect(matchGlob('a?.ts', 'ab.ts')).toBe(true);
    expect(matchGlob('a?.ts', 'abc.ts')).toBe(false);
  });
});

// ── IndexedKaos ──────────────────────────────────────────────────────

describe('IndexedKaos', () => {
  it('throws IndexMissError for missing files', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);
    await expect(kaos.readText('/missing')).rejects.toThrow();
  });

  it('reads from index after write', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);
    await kaos.writeText('/test.txt', 'hello');
    const content = await kaos.readText('/test.txt');
    expect(content).toBe('hello');
  });

  it('glob queries index in memory', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);
    await kaos.writeText('src/a.ts', 'a');
    await kaos.writeText('src/b.ts', 'b');

    const results: string[] = [];
    for await (const path of kaos.glob('src', '*.ts')) {
      results.push(path);
    }
    expect(results).toContain('src/a.ts');
    expect(results).toContain('src/b.ts');
  });

  it('exec is blocked', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);
    await expect(kaos.exec('ls')).rejects.toThrow();
  });
});

// ── HermeticKaos ─────────────────────────────────────────────────────

describe('HermeticKaos', () => {
  it('reads from index', async () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('/file.txt', 'content');
    const kaos = new HermeticKaos(mockDelegate, index);
    expect(await kaos.readText('/file.txt')).toBe('content');
  });

  it('refreshes snapshot after write (CoW)', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new HermeticKaos(mockDelegate, index);

    const snapshotBefore = kaos.getSnapshot();
    expect(snapshotBefore.files.size).toBe(0);

    await kaos.writeText('/new.txt', 'data');
    const snapshotAfter = kaos.getSnapshot();
    expect(snapshotAfter.files.size).toBe(1);
  });

  it('exec is blocked', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new HermeticKaos(mockDelegate, index);
    await expect(kaos.exec('ls')).rejects.toThrow();
  });
});

// ── IndexedSessionInitializer ────────────────────────────────────────

describe('IndexedSessionInitializer', () => {
  it('creates IndexedKaos from delegate', () => {
    const init = new IndexedSessionInitializer(mockDelegate);
    const hermetic = init.createSubagentKaos(MerkleFileIndex.empty());
    expect(hermetic.name).toBe('hermetic');
  });

  it('creates subagent kaos with snapshot', async () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('a.txt', 'hello');
    const init = new IndexedSessionInitializer(mockDelegate);
    const subagent = init.createSubagentKaos(index);

    const snap = subagent.getSnapshot();
    expect(snap.files.size).toBe(1);
    expect(snap.files.has('a.txt')).toBe(true);
  });
});

// ── MutationLog ──────────────────────────────────────────────────────

describe('MutationLog', () => {
  it('linearizes by staticSequenceId then path', () => {
    const log = new MutationLog();
    log.record({ type: 'write', path: 'b.ts', content: 'b', staticSequenceId: 2, agentId: 'a1' });
    log.record({ type: 'write', path: 'a.ts', content: 'a', staticSequenceId: 1, agentId: 'a2' });
    log.record({ type: 'write', path: 'a.ts', content: 'a2', staticSequenceId: 1, agentId: 'a3' });

    const sorted = log.linearize();
    expect(sorted[0]!.staticSequenceId).toBe(1);
    expect(sorted[2]!.staticSequenceId).toBe(2);
    expect(sorted[2]!.path).toBe('b.ts');
  });

  it('detects conflicts on same path', () => {
    const log = new MutationLog();
    log.record({ type: 'write', path: 'x.ts', content: '1', staticSequenceId: 1, agentId: 'a1' });
    log.record({ type: 'write', path: 'x.ts', content: '2', staticSequenceId: 2, agentId: 'a2' });
    log.record({ type: 'write', path: 'y.ts', content: '3', staticSequenceId: 3, agentId: 'a1' });

    const conflicts = log.detectConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.path).toBe('x.ts');
    expect(conflicts[0]!.ops.length).toBe(2);
  });
});

// ── DeterministicReducer ─────────────────────────────────────────────

describe('DeterministicReducer', () => {
  it('applies operations in deterministic order', () => {
    const index = MerkleFileIndex.empty();
    const pool = new ContentAddressedPool();
    const reducer = new DeterministicReducer();

    const ops: MutationOp[] = [
      { type: 'write', path: 'b.ts', content: 'b', staticSequenceId: 2, agentId: 'a1' },
      { type: 'write', path: 'a.ts', content: 'a', staticSequenceId: 1, agentId: 'a2' },
    ];

    reducer.reduce(ops, index, pool);
    expect(index.getFile('a.ts')).toBe('a');
    expect(index.getFile('b.ts')).toBe('b');
  });

  it('delete dominates over write at same sequence id', () => {
    const reducer = new DeterministicReducer();
    const conflicts: FileConflict[] = [{
      path: 'x.ts',
      ops: [
        { type: 'write', path: 'x.ts', content: 'new', staticSequenceId: 1, agentId: 'a1' },
        { type: 'delete', path: 'x.ts', staticSequenceId: 1, agentId: 'a2' },
      ],
    }];

    const resolved = reducer.resolveConflicts(conflicts);
    expect(resolved[0]!.type).toBe('delete');
  });
});

// ── GenerationGarbageCollector ───────────────────────────────────────

describe('GenerationGarbageCollector', () => {
  it('sweep removes pool entries not referenced by the index', () => {
    const pool = new ContentAddressedPool();

    // Put content into the pool directly (simulating stale entries).
    const staleHash = pool.put(Buffer.from('stale'));
    // Put content that will be referenced by the index.
    const liveContent = Buffer.from('live');
    const liveHash = pool.put(liveContent);

    expect(pool.size).toBe(2);

    // Build an index that only references the live hash.
    const index = MerkleFileIndex.empty(pool);
    index.files.set('live.txt', {
      contentHash: liveHash,
      size: liveContent.length,
      mtime: Date.now() / 1000,
    });

    const gc = new GenerationGarbageCollector(pool);
    const result = gc.collect(index);

    expect(result.removedCount).toBe(1);
    expect(result.remainingCount).toBe(1);
    expect(result.freedBytes).toBe(Buffer.from('stale').length);
    expect(pool.has(staleHash)).toBe(false);
    expect(pool.has(liveHash)).toBe(true);
  });

  it('collect returns zero removals when all entries are live', () => {
    const pool = new ContentAddressedPool();
    const index = MerkleFileIndex.empty(pool);

    index.writeFile('a.txt', 'aaa');
    index.writeFile('b.txt', 'bbb');

    const gc = new GenerationGarbageCollector(pool);
    const result = gc.collect(index);

    expect(result.removedCount).toBe(0);
    expect(result.remainingCount).toBe(2);
    expect(result.freedBytes).toBe(0);
  });
});
