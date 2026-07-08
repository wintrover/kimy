import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Kaos } from '../src/kaos';
import { MerkleFileIndex } from '../src/merkle-file-index';
import { IndexedKaos } from '../src/indexed-kaos';
import { HermeticKaos } from '../src/hermetic-kaos';
import { ContentAddressedPool } from '../src/object-pool';
import { SymlinkAtomicCommitter } from '../src/symlink-committer';
import { MutationLog, DeterministicReducer } from '../../agent-core/src/agent/mutation-log';
import type { MutationOp, FileConflict } from '../../agent-core/src/agent/mutation-log';

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Minimal mock Kaos for tests that need path ops only.
 * IndexedKaos reads from the index, not the delegate.
 */
function createMockDelegate(): Kaos {
  const self: Kaos = {
    name: 'mock-delegate',
    osEnv: undefined as unknown as Kaos['osEnv'],
    pathClass: () => 'posix' as const,
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => '/workspace',
    chdir: async () => {},
    withCwd: () => self,
    withEnv: () => self,
    stat: async () => ({
      stMode: 0o100644, stIno: 0, stDev: 0, stNlink: 1,
      stUid: 0, stGid: 0, stSize: 0, stAtime: 0, stMtime: 0, stCtime: 0,
    }),
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
  return self;
}

const mockDelegate = createMockDelegate();

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaos-epoch-test-'));
}

// ── Test 1: MutationLog records writes from IndexedKaos ─────────────

describe('MutationLog records writes from IndexedKaos', () => {
  it('records write ops with correct type, path, content, sequenceId, agentId', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 100;
    kaos.setMutationLog(log, () => seq++);
    kaos.setAgentId('agent-alpha');

    await kaos.writeText('src/main.ts', 'console.log("hello")');
    await kaos.writeText('src/utils.ts', 'export const x = 1');
    await kaos.writeBytes('src/buf.txt', Buffer.from('binary-data'));

    const ops = log.linearize();
    expect(ops.length).toBe(3);

    expect(ops[0]!.type).toBe('write');
    expect(ops[0]!.path).toBe('src/main.ts');
    expect(ops[0]!.content).toBe('console.log("hello")');
    expect(ops[0]!.staticSequenceId).toBe(100);
    expect(ops[0]!.agentId).toBe('agent-alpha');

    expect(ops[1]!.type).toBe('write');
    expect(ops[1]!.path).toBe('src/utils.ts');
    expect(ops[1]!.content).toBe('export const x = 1');
    expect(ops[1]!.staticSequenceId).toBe(101);
    expect(ops[1]!.agentId).toBe('agent-alpha');

    expect(ops[2]!.type).toBe('write');
    expect(ops[2]!.path).toBe('src/buf.txt');
    expect(ops[2]!.content).toBe('binary-data');
    expect(ops[2]!.staticSequenceId).toBe(102);
    expect(ops[2]!.agentId).toBe('agent-alpha');
  });

  it('records delete ops', async () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('old.txt', 'stale');
    const kaos = new IndexedKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 1;
    kaos.setMutationLog(log, () => seq++);
    kaos.setAgentId('agent-beta');

    await kaos.deleteFile('old.txt');

    const ops = log.linearize();
    expect(ops.length).toBe(1);
    expect(ops[0]!.type).toBe('delete');
    expect(ops[0]!.path).toBe('old.txt');
    expect(ops[0]!.agentId).toBe('agent-beta');
  });
});

// ── Test 2: MutationLog records writes from HermeticKaos ─────────────

describe('MutationLog records writes from HermeticKaos', () => {
  it('records write ops with correct fields', async () => {
    const index = MerkleFileIndex.empty();
    const hermetic = new HermeticKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 200;
    hermetic.setMutationLog(log, () => seq++);
    hermetic.setAgentId('agent-gamma');

    await hermetic.writeText('config.json', '{"key":"value"}');
    await hermetic.writeText('readme.md', '# Hello');

    const ops = log.linearize();
    expect(ops.length).toBe(2);

    expect(ops[0]!.type).toBe('write');
    expect(ops[0]!.path).toBe('config.json');
    expect(ops[0]!.content).toBe('{"key":"value"}');
    expect(ops[0]!.staticSequenceId).toBe(200);
    expect(ops[0]!.agentId).toBe('agent-gamma');

    expect(ops[1]!.type).toBe('write');
    expect(ops[1]!.path).toBe('readme.md');
    expect(ops[1]!.content).toBe('# Hello');
    expect(ops[1]!.staticSequenceId).toBe(201);
    expect(ops[1]!.agentId).toBe('agent-gamma');
  });

  it('records write ops from HermeticKaos.writeBytes', async () => {
    const index = MerkleFileIndex.empty();
    const hermetic = new HermeticKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 0;
    hermetic.setMutationLog(log, () => seq++);

    await hermetic.writeBytes('data.bin', Buffer.from('raw-bytes'));

    const ops = log.linearize();
    expect(ops.length).toBe(1);
    expect(ops[0]!.content).toBe('raw-bytes');
  });
});

// ── Test 3: Epoch snapshot + restore round-trips correctly ──────────

describe('Epoch snapshot + restore round-trips correctly', () => {
  it('restores index to snapshot state after additional writes', async () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('keep-a.txt', 'aaa');
    index.writeFile('keep-b.txt', 'bbb');

    const snapshot = index.branch();
    expect(snapshot.files.size).toBe(2);

    // Mutate after snapshot
    index.writeFile('new-c.txt', 'ccc');
    index.writeFile('keep-a.txt', 'modified');
    index.deleteFile('keep-b.txt');
    expect(index.files.size).toBe(2);

    // Restore snapshot
    index.restoreFromSnapshot(snapshot);

    expect(index.files.size).toBe(2);
    expect(index.getFileContent('keep-a.txt')).toBe('aaa');
    expect(index.getFileContent('keep-b.txt')).toBe('bbb');
    expect(index.getFileContent('new-c.txt')).toBeUndefined();
  });

  it('rootHash matches after restore', () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('a.txt', 'content');
    const hashBefore = index.rootHash;

    const snapshot = index.branch();

    index.writeFile('extra.txt', 'extra');
    expect(index.rootHash).not.toBe(hashBefore);

    index.restoreFromSnapshot(snapshot);
    expect(index.rootHash).toBe(hashBefore);
  });

  it('IndexedKaos reads correctly after restore', async () => {
    const index = MerkleFileIndex.empty();
    index.writeFile('data.txt', 'original');
    const snapshot = index.branch();

    const kaos = new IndexedKaos(mockDelegate, index);
    await kaos.writeText('data.txt', 'changed');
    await kaos.writeText('temp.txt', 'temporary');

    expect(await kaos.readText('data.txt')).toBe('changed');

    index.restoreFromSnapshot(snapshot);
    expect(await kaos.readText('data.txt')).toBe('original');

    const { IndexMissError } = await import('../src/indexed-kaos');
    await expect(kaos.readText('temp.txt')).rejects.toThrow(IndexMissError);
  });
});

// ── Test 4: Epoch commit with SymlinkAtomicCommitter ─────────────────

describe('Epoch commit with SymlinkAtomicCommitter', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stages and commits a generation without throwing', async () => {
    tmpDir = makeTempDir();

    const index = MerkleFileIndex.empty();
    index.writeFile('file-a.txt', 'aaa');
    index.writeFile('sub/dir/file-b.txt', 'bbb');

    const baseSnapshot = index.branch();

    index.writeFile('file-a.txt', 'updated');
    index.writeFile('file-c.txt', 'ccc');

    const currentSnapshot = index.branch();

    const committer = new SymlinkAtomicCommitter(tmpDir);
    await committer.init();

    const pool = index.getPool();
    const gen = committer.stageFromSnapshot(currentSnapshot, baseSnapshot, pool);
    expect(gen.id).toBe(1);

    committer.commit(gen, index);

    expect(committer.currentGenId).toBe(1);
    expect(committer.getCurrentGeneration()).not.toBeNull();

    // Verify materialized files on disk
    const genDir = committer.getCurrentGeneration()!;
    expect(fs.existsSync(path.join(genDir, 'file-a.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(genDir, 'file-a.txt'), 'utf-8')).toBe('updated');
    expect(fs.readFileSync(path.join(genDir, 'file-c.txt'), 'utf-8')).toBe('ccc');
    // file-b.txt was in the base snapshot but unchanged — only staged for hard-link.
    // In FULL_WRITE mode it won't appear; in HARD_LINK mode it may.
  });

  it('second commit increments generation', async () => {
    tmpDir = makeTempDir();

    const index = MerkleFileIndex.empty();
    const pool = index.getPool();

    const committer = new SymlinkAtomicCommitter(tmpDir);
    await committer.init();

    // First commit
    index.writeFile('a.txt', 'first');
    const snap1 = index.branch();
    const gen1 = committer.stageFromSnapshot(snap1, undefined, pool);
    committer.commit(gen1, index);
    expect(committer.currentGenId).toBe(1);

    // Remove the first generation so HARD_LINK falls through to full write.
    const firstGenDir = committer.getCurrentGeneration()!;
    fs.rmSync(firstGenDir, { recursive: true, force: true });

    // Second commit
    index.writeFile('a.txt', 'second');
    const snap2 = index.branch();
    const gen2 = committer.stageFromSnapshot(snap2, undefined, pool);
    expect(gen2.id).toBe(2);
    committer.commit(gen2, index);
    expect(committer.currentGenId).toBe(2);

    // Verify the second generation is active with updated content
    const genDir = committer.getCurrentGeneration()!;
    expect(fs.readFileSync(path.join(genDir, 'a.txt'), 'utf-8')).toBe('second');
  });
});

// ── Test 5: DeterministicReducer resolves conflicts ─────────────────

describe('DeterministicReducer resolves conflicts', () => {
  it('SLWW: higher staticSequenceId wins among writes', () => {
    const log = new MutationLog();
    log.record({ type: 'write', path: 'shared.ts', content: 'first', staticSequenceId: 1, agentId: 'a1' });
    log.record({ type: 'write', path: 'shared.ts', content: 'second', staticSequenceId: 5, agentId: 'a2' });
    log.record({ type: 'write', path: 'solo.ts', content: 'solo', staticSequenceId: 3, agentId: 'a1' });

    const conflicts = log.detectConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.path).toBe('shared.ts');
    expect(conflicts[0]!.ops.length).toBe(2);

    const reducer = new DeterministicReducer();
    const resolved = reducer.resolveConflicts(conflicts);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.content).toBe('second');
    expect(resolved[0]!.staticSequenceId).toBe(5);

    // Reduce into a fresh index
    const index = MerkleFileIndex.empty();
    const pool = new ContentAddressedPool();
    reducer.reduce(resolved, index, pool);
    expect(index.getFileContent('shared.ts')).toBe('second');
  });

  it('delete dominates over write', () => {
    const log = new MutationLog();
    log.record({ type: 'write', path: 'doomed.ts', content: 'v1', staticSequenceId: 1, agentId: 'a1' });
    log.record({ type: 'delete', path: 'doomed.ts', staticSequenceId: 2, agentId: 'a2' });

    const conflicts = log.detectConflicts();
    const reducer = new DeterministicReducer();
    const resolved = reducer.resolveConflicts(conflicts);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.type).toBe('delete');

    const index = MerkleFileIndex.empty();
    index.writeFile('doomed.ts', 'should be removed');
    const pool = new ContentAddressedPool();
    reducer.reduce(resolved, index, pool);
    expect(index.getFileContent('doomed.ts')).toBeUndefined();
  });

  it('reduces linearised ops into index deterministically', () => {
    const log = new MutationLog();
    log.record({ type: 'write', path: 'z.ts', content: 'z', staticSequenceId: 10, agentId: 'a1' });
    log.record({ type: 'write', path: 'a.ts', content: 'a', staticSequenceId: 2, agentId: 'a2' });
    log.record({ type: 'write', path: 'm.ts', content: 'm', staticSequenceId: 5, agentId: 'a1' });

    const index = MerkleFileIndex.empty();
    const pool = new ContentAddressedPool();
    const reducer = new DeterministicReducer();

    // Pass all ops — no conflicts since different paths
    const reducer2 = new DeterministicReducer();
    const allOps = log.linearize();
    reducer2.reduce(allOps, index, pool);

    expect(index.getFileContent('a.ts')).toBe('a');
    expect(index.getFileContent('m.ts')).toBe('m');
    expect(index.getFileContent('z.ts')).toBe('z');
  });
});

// ── Test 6: SequentialId increments deterministically ────────────────

describe('SequentialId increments deterministically', () => {
  it('each MutationOp has strictly increasing staticSequenceId', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);

    const log = new MutationLog();
    let nextId = 0;
    kaos.setMutationLog(log, () => nextId++);
    kaos.setAgentId('seq-agent');

    const fileCount = 10;
    for (let i = 0; i < fileCount; i++) {
      await kaos.writeText(`file-${i}.txt`, `content-${i}`);
    }

    const ops = log.linearize();
    expect(ops.length).toBe(fileCount);

    for (let i = 0; i < ops.length; i++) {
      expect(ops[i]!.staticSequenceId).toBe(i);
      if (i > 0) {
        expect(ops[i]!.staticSequenceId).toBeGreaterThan(ops[i - 1]!.staticSequenceId);
      }
    }
  });

  it('counter resets are visible when a new counter is injected', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 50;
    kaos.setMutationLog(log, () => seq++);

    await kaos.writeText('first.txt', '1');
    expect(log.size).toBe(1);

    // Re-inject with a new counter starting from 1000
    seq = 1000;
    await kaos.writeText('second.txt', '2');
    expect(log.size).toBe(2);

    const ops = log.linearize();
    expect(ops[0]!.staticSequenceId).toBe(50);
    expect(ops[1]!.staticSequenceId).toBe(1000);
  });

  it('withCwd threads the mutation log and counter', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 0;
    kaos.setMutationLog(log, () => seq++);
    kaos.setAgentId('threaded');

    const child = kaos.withCwd('/workspace/sub');
    await child.writeText('child-file.txt', 'from-child');

    const ops = log.linearize();
    expect(ops.length).toBe(1);
    expect(ops[0]!.agentId).toBe('threaded');
    expect(ops[0]!.staticSequenceId).toBe(0);
  });

  it('withEnv threads the mutation log and counter', async () => {
    const index = MerkleFileIndex.empty();
    const kaos = new IndexedKaos(mockDelegate, index);

    const log = new MutationLog();
    let seq = 0;
    kaos.setMutationLog(log, () => seq++);
    kaos.setAgentId('env-agent');

    const child = kaos.withEnv({ NODE_ENV: 'test' });
    await child.writeText('env-file.txt', 'env-data');

    const ops = log.linearize();
    expect(ops.length).toBe(1);
    expect(ops[0]!.agentId).toBe('env-agent');
  });
});
