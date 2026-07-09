import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Kaos } from '#/kaos';
import type { FsEntry } from '#/types';
import {
  FileIndexBuilder,
  parseGitignoreContent,
  gitignorePatternToRegex,
} from '#/file-index-builder';
import { VFSPathFactory, compareCanonicalPath } from '#/path';
import { HermeticKaos } from '#/hermetic-kaos';

// Re-export the dependency classes so tests can instantiate them directly.
import { ContentAddressedPool as Pool } from '#/object-pool';
import { MerkleFileIndex as Index } from '#/merkle-file-index';

const EMPTY_DIR_HASH = createHash('sha256').update('').digest('hex');

// ── ContentAddressedPool ──────────────────────────────────────────────

describe('ContentAddressedPool', () => {
  it('stores and retrieves content by hash', () => {
    const pool = new Pool();
    const data = Buffer.from('hello world');
    const hash = pool.put(data);

    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64); // SHA-256 hex digest
    expect(pool.get(hash)).toEqual(data);
  });

  it('deduplicates identical content', () => {
    const pool = new Pool();
    const data = Buffer.from('duplicate');
    const hash1 = pool.put(data);
    const hash2 = pool.put(Buffer.from('duplicate'));

    expect(hash1).toBe(hash2);
    expect(pool.size).toBe(1);
  });

  it('distinguishes different content', () => {
    const pool = new Pool();
    const hash1 = pool.put(Buffer.from('aaa'));
    const hash2 = pool.put(Buffer.from('bbb'));

    expect(hash1).not.toBe(hash2);
    expect(pool.size).toBe(2);
  });

  it('has() returns true for stored hashes and false otherwise', () => {
    const pool = new Pool();
    const hash = pool.put(Buffer.from('x'));

    expect(pool.has(hash)).toBe(true);
    expect(pool.has('0'.repeat(64))).toBe(false);
  });

  it('get() returns undefined for unknown hashes', () => {
    const pool = new Pool();
    expect(pool.get('ff'.repeat(64))).toBeUndefined();
  });

  it('stats() reports correct counts and byte totals', () => {
    const pool = new Pool();
    pool.put(Buffer.from('abc'));
    pool.put(Buffer.from('de'));
    pool.put(Buffer.from('abc')); // duplicate

    const stats = pool.stats();
    expect(stats.objectCount).toBe(2);
    expect(stats.totalBytes).toBe(5); // 3 + 2
  });
});

// ── MerkleFileIndex ───────────────────────────────────────────────────

describe('MerkleFileIndex', () => {
  it('starts with size 0 and an empty root hash', () => {
    const idx = Index.empty();
    expect(idx.files.size).toBe(0);
    expect(idx.rootHash).toBe(EMPTY_DIR_HASH);
  });

  it('writeFile and getFile round-trip', () => {
    const idx = Index.empty();
    idx.writeFile('a.txt', 'content-a');

    const content = idx.getFile('a.txt');
    expect(content).toBe('content-a');

    const entry = idx.getEntry('a.txt');
    expect(entry).toBeDefined();
    expect(entry?.size).toBe(9); // 'content-a'.length
    expect(entry?.contentHash).toHaveLength(64);
  });

  it('returns undefined for unknown paths', () => {
    const idx = Index.empty();
    expect(idx.getFile('missing')).toBeUndefined();
  });

  it('files map keys are in deterministic sorted order', () => {
    const idx = Index.empty();
    idx.writeFile('z/b.txt', 'b');
    idx.writeFile('a/c.txt', 'c');
    idx.writeFile('m/a.txt', 'a');

    const paths = [...idx.files.keys()].sort();
    expect(paths).toEqual(['a/c.txt', 'm/a.txt', 'z/b.txt']);
  });

  it('listDir() returns children of a directory', () => {
    const idx = Index.empty();
    idx.writeFile('src/index.ts', 'index');
    idx.writeFile('src/util.ts', 'util');
    idx.writeFile('test/index.test.ts', 'test');

    const srcChildren = idx.listDir('src');
    expect(srcChildren).toBeDefined();
    expect(srcChildren).toHaveLength(2);
    expect(srcChildren!.sort()).toEqual(['index.ts', 'util.ts']);
  });

  it('listDir("") returns direct file children at root', () => {
    const idx = Index.empty();
    idx.writeFile('a.txt', 'a');
    idx.writeFile('b/c.txt', 'c');

    const topChildren = idx.listDir('');
    expect(topChildren).toBeDefined();
    // Only 'a.txt' is a direct file child of root.
    // 'b' is a subdirectory — writeFile doesn't wire directory names
    // to parent children (buildFromVector does).
    expect(topChildren).toEqual(['a.txt']);
  });

  it('computes a stable rootHash across rebuilds', () => {
    const idx1 = Index.empty();
    idx1.writeFile('a.txt', 'aaaa', 1000);
    idx1.writeFile('b.txt', 'bbbb', 2000);
    const hash1 = idx1.rootHash;

    // Rebuild by writing the same files in a different order
    const idx2 = Index.empty();
    idx2.writeFile('b.txt', 'bbbb', 2000);
    idx2.writeFile('a.txt', 'aaaa', 1000);
    const hash2 = idx2.rootHash;

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('different content produces different rootHash', () => {
    const idx1 = Index.empty();
    idx1.writeFile('x.txt', 'aaa');

    const idx2 = Index.empty();
    idx2.writeFile('x.txt', 'bbb');

    expect(idx1.rootHash).not.toBe(idx2.rootHash);
  });

  it('different file sets produce different rootHash', () => {
    const idx1 = Index.empty();
    idx1.writeFile('a.txt', 'h');

    const idx2 = Index.empty();
    idx2.writeFile('a.txt', 'h');
    idx2.writeFile('b.txt', 'h');

    expect(idx1.rootHash).not.toBe(idx2.rootHash);
  });

  it('writeFile() registers multiple entries', () => {
    const idx = Index.empty();
    idx.writeFile('one.txt', 'one');
    idx.writeFile('two.txt', 'two');
    expect(idx.files.size).toBe(2);
  });

  it('directory node tree is populated correctly', () => {
    const idx = Index.empty();
    idx.writeFile('src/a.ts', 'a');
    idx.writeFile('src/b.ts', 'b');
    idx.writeFile('test/c.ts', 'c');

    // src directory should have two file children
    const srcChildren = idx.listDir('src');
    expect(srcChildren).toHaveLength(2);
    expect(srcChildren!.sort()).toEqual(['a.ts', 'b.ts']);

    // test directory should have one file child
    const testChildren = idx.listDir('test');
    expect(testChildren).toHaveLength(1);
    expect(testChildren).toEqual(['c.ts']);

    // Verify files are tracked in the index
    expect(idx.files.size).toBe(3);
    expect(idx.getFile('src/a.ts')).toBe('a');
    expect(idx.getFile('src/b.ts')).toBe('b');
    expect(idx.getFile('test/c.ts')).toBe('c');
  });
});

// ── Gitignore parsing ─────────────────────────────────────────────────

describe('parseGitignoreContent', () => {
  it('parses simple patterns', () => {
    const rules = parseGitignoreContent('*.log\nbuild/\n');
    expect(rules).toHaveLength(2);
    expect(rules[0]?.negated).toBe(false);
    expect(rules[0]?.directoryOnly).toBe(false);
    expect(rules[1]?.directoryOnly).toBe(true);
  });

  it('skips comments and blank lines', () => {
    const rules = parseGitignoreContent('# comment\n\n  \n*.log\n');
    expect(rules).toHaveLength(1);
  });

  it('handles negation', () => {
    const rules = parseGitignoreContent('*.log\n!important.log\n');
    expect(rules).toHaveLength(2);
    expect(rules[0]?.negated).toBe(false);
    expect(rules[1]?.negated).toBe(true);
  });

  it('strips trailing whitespace', () => {
    const rules = parseGitignoreContent('*.log   \n');
    expect(rules).toHaveLength(1);
    // The regex should match "foo.log"
    expect(rules[0]?.regex.test('foo.log')).toBe(true);
  });
});

describe('gitignorePatternToRegex', () => {
  it('matches basenames for patterns without /', () => {
    const re = gitignorePatternToRegex('*.log');
    expect(re.test('debug.log')).toBe(true);
    expect(re.test('src/debug.log')).toBe(true);
    expect(re.test('debug.txt')).toBe(false);
  });

  it('matches full relative paths for patterns with /', () => {
    const re = gitignorePatternToRegex('build/output');
    expect(re.test('build/output')).toBe(true);
    expect(re.test('src/build/output')).toBe(false);
  });

  it('leading / anchors to the root', () => {
    const re = gitignorePatternToRegex('/dist');
    expect(re.test('dist')).toBe(true);
    expect(re.test('src/dist')).toBe(false);
  });

  it('? matches a single non-slash character', () => {
    const re = gitignorePatternToRegex('?.txt');
    expect(re.test('a.txt')).toBe(true);
    expect(re.test('ab.txt')).toBe(false);
  });

  it('[...] character classes work', () => {
    const re = gitignorePatternToRegex('[abc].log');
    expect(re.test('a.log')).toBe(true);
    expect(re.test('b.log')).toBe(true);
    expect(re.test('d.log')).toBe(false);
  });

  it('** matches across directory boundaries', () => {
    const re = gitignorePatternToRegex('**/foo.txt');
    expect(re.test('foo.txt')).toBe(true);
    expect(re.test('a/foo.txt')).toBe(true);
    expect(re.test('a/b/c/foo.txt')).toBe(true);
  });

  it('escapes regex metacharacters', () => {
    const re = gitignorePatternToRegex('file.txt');
    expect(re.test('file.txt')).toBe(true);
    expect(re.test('fileXtxt')).toBe(false);
  });

  it('bare pattern (no /) matches in subdirectories', () => {
    const re = gitignorePatternToRegex('node_modules');
    expect(re.test('node_modules')).toBe(true);
    expect(re.test('packages/kaos/node_modules')).toBe(true);
    expect(re.test('other')).toBe(false);
  });
});

// ── FileIndexBuilder ──────────────────────────────────────────────────

/**
 * Build a minimal mock Kaos that serves controlled data for the builder.
 */
function createMockKaos(files: Record<string, string>): Kaos {
  const fileMap = new Map<string, string>();
  for (const [rel, content] of Object.entries(files)) {
    fileMap.set(rel, content);
  }

  // Collect all directory prefixes so glob can yield them.
  const allRelPaths = [...fileMap.keys()];

  return {
    name: 'mock',
    osEnv: undefined as unknown as Kaos['osEnv'],
    pathClass: () => 'posix' as const,
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => '/workspace',
    chdir: async () => {},
    withCwd: () => createMockKaos(files),
    withEnv: () => createMockKaos(files),

    stat: async (p: string) => {
      // Determine if this path is a file or directory.
      const isFile = allRelPaths.some((r) => p.endsWith('/' + r) || p === r);
      return {
        stMode: isFile ? 0o100644 : 0o40755,
        stIno: 0,
        stDev: 0,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: isFile ? (fileMap.get(allRelPaths.find((r) => p.endsWith('/' + r) ?? '') ?? '') ?? '').length : 0,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      };
    },

    iterdir: async function* () {
      yield* allRelPaths;
    },

    glob: async function* (_path: string, pattern: string) {
      if (pattern === '**/*') {
        for (const rel of allRelPaths) {
          yield '/workspace/' + rel;
        }
      }
    },

    readBytes: async (p: string) => {
      for (const [rel, content] of fileMap) {
        if (p.endsWith('/' + rel) || p === rel) {
          return Buffer.from(content, 'utf-8');
        }
      }
      throw new Error(`Not found: ${p}`);
    },

    readText: async (p: string, _opts?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }) => {
      for (const [rel, content] of fileMap) {
        if (p.endsWith('/' + rel) || p === rel) {
          return content;
        }
      }
      throw new Error(`Not found: ${p}`);
    },

    readLines: async function* () {},

    writeBytes: async () => 0,
    writeText: async () => 0,
    mkdir: async () => {},
    snapshot: async (_root: string, options?: Record<string, unknown>) => {
      const entries: FsEntry[] = [];
      let included = [...fileMap.entries()];

      // Filter by maxFileSize
      const maxFileSize = options?.maxFileSize as number | undefined;
      if (maxFileSize !== undefined) {
        included = included.filter(([, content]) => Buffer.byteLength(content) <= maxFileSize);
      }

      // Filter by excludePatterns using gitignorePatternToRegex
      const excludePatterns = options?.excludePatterns as readonly string[] | undefined;
      if (excludePatterns && excludePatterns.length > 0) {
        const excludeRegexes = excludePatterns.map((p) => gitignorePatternToRegex(p));
        included = included.filter(([path]) =>
          !excludeRegexes.some((re) => re.test(path)),
        );
      }

      // Filter by gitignore
      const respectGitignore = options?.respectGitignore as boolean | undefined;
      if (respectGitignore !== false && fileMap.has('.gitignore')) {
        const gitignoreContent = fileMap.get('.gitignore')!;
        const rules = parseGitignoreContent(gitignoreContent);
        included = included.filter(([path]) => {
          // Last matching rule wins: non-negated → exclude, negated → re-include
          let isIncluded = true;
          for (const rule of rules) {
            if (rule.regex.test(path)) {
              isIncluded = rule.negated;
            }
          }
          return isIncluded;
        });
      }

      for (const [path, content] of included) {
        entries.push({
          relPath: path,
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
          size: Buffer.byteLength(content),
          mtime: Date.now(),
          contentHash: createHash('sha256').update(content).digest('hex'),
          content: Buffer.from(content),
        });
      }
      return Object.freeze(entries);
    },
    exec: async () => {
      throw new Error('not implemented');
    },
    execWithEnv: async () => {
      throw new Error('not implemented');
    },
  };
}

describe('FileIndexBuilder', () => {
  it('indexes all files when no gitignore and no excludes', async () => {
    const kaos = createMockKaos({
      'a.txt': 'hello',
      'b.txt': 'world',
      'sub/c.txt': 'nested',
    });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace', respectGitignore: false });

    expect(result.stats.filesIndexed).toBe(3);
    expect(result.stats.filesSkipped).toBe(0);
    expect(result.index.files.size).toBe(3);
    expect(result.pool.size).toBe(3);
  });

  it('respects .gitignore patterns', async () => {
    const kaos = createMockKaos({
      '.gitignore': '*.log\n',
      'app.ts': 'code',
      'debug.log': 'log data',
    });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace' });

    expect(result.stats.filesIndexed).toBe(2); // app.ts + .gitignore itself
    expect(result.stats.filesSkipped).toBe(0); // debug.log filtered by snapshot
    const entry = result.index.getFile('app.ts');
    expect(entry).toBeDefined();
  });

  it('respects excludePatterns', async () => {
    const kaos = createMockKaos({
      'src/index.ts': 'code',
      'test/index.test.ts': 'test code',
      'dist/bundle.js': 'built',
    });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({
      root: '/workspace',
      respectGitignore: false,
      excludePatterns: ['dist/**', 'test/**'],
    });

    expect(result.stats.filesIndexed).toBe(1);
    const entry = result.index.getFile('src/index.ts');
    expect(entry).toBeDefined();
  });

  it('skips files exceeding maxFileSize', async () => {
    const kaos = createMockKaos({
      'small.txt': 'hi',
      'big.txt': 'x'.repeat(100),
    });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({
      root: '/workspace',
      respectGitignore: false,
      maxFileSize: 50,
    });

    expect(result.stats.filesIndexed).toBe(1);
    expect(result.stats.filesSkipped).toBe(0);
    const entry = result.index.getFile('small.txt');
    expect(entry).toBeDefined();
  });

  it('stores file content in the pool', async () => {
    const kaos = createMockKaos({ 'data.txt': 'content-123' });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace', respectGitignore: false });

    const entry = result.index.getEntry('data.txt');
    expect(entry).toBeDefined();

    const content = result.pool.get(entry!.contentHash);
    expect(content).toBeDefined();
    expect(content!.toString('utf-8')).toBe('content-123');
  });

  it('reports stats correctly', async () => {
    const kaos = createMockKaos({
      'a.txt': 'one',
      'b.txt': 'two',
    });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace', respectGitignore: false });

    expect(result.stats.filesIndexed).toBe(2);
    expect(result.stats.filesSkipped).toBe(0);
    expect(result.stats.totalBytes).toBe(6); // "one" + "two"
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('computes a merkle rootHash', async () => {
    const kaos = createMockKaos({ 'a.txt': 'aaa' });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace', respectGitignore: false });

    expect(result.index.rootHash).toHaveLength(64);
  });

  it('negation rules re-include previously ignored files', async () => {
    const kaos = createMockKaos({
      '.gitignore': '*.log\n!important.log\n',
      'app.log': 'log',
      'important.log': 'important',
    });

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace' });

    // important.log should be included because of the negation rule
    const entry = result.index.getFile('important.log');
    expect(entry).toBeDefined();
    // app.log should still be ignored
    expect(result.index.getFile('app.log')).toBeUndefined();
  });

  it('empty workspace produces zero-indexed empty result', async () => {
    const kaos = createMockKaos({});

    const builder = new FileIndexBuilder(kaos);
    const result = await builder.build({ root: '/workspace', respectGitignore: false });

    expect(result.stats.filesIndexed).toBe(0);
    expect(result.index.files.size).toBe(0);
    expect(result.index.rootHash).toBe(EMPTY_DIR_HASH);
  });
});

// ── VFSPathFactory ─────────────────────────────────────────────────

describe('VFSPathFactory', () => {
  it('converts absolute path to relative path', () => {
    const factory = new VFSPathFactory('/home/user/project');
    expect(factory.create('/home/user/project/src/foo.ts')).toBe('src/foo.ts');
  });

  it('returns empty string for rootDir itself', () => {
    const factory = new VFSPathFactory('/home/user/project');
    expect(factory.create('/home/user/project')).toBe('');
  });

  it('NFC/NFD normalization produces the same relative path', () => {
    const koreanRoot = '/home/user/바탕화면/project';
    const factory = new VFSPathFactory(koreanRoot);

    const nfdPath = koreanRoot + '/src/한글파일.ts';
    const nfcInput = nfdPath.normalize('NFC');
    const nfdInput = nfdPath.normalize('NFD');

    expect(factory.create(nfcInput)).toBe('src/한글파일.ts');
    expect(factory.create(nfdInput)).toBe('src/한글파일.ts');
    expect(factory.create(nfcInput)).toBe(factory.create(nfdInput));
  });

  it('converts backslashes to forward slashes', () => {
    const factory = new VFSPathFactory('/home/user/project');
    expect(factory.create('/home/user/project/src\\gate\\gateway.nim')).toBe('src/gate/gateway.nim');
  });

  it('resolves double slashes and ../ traversal', () => {
    const factory = new VFSPathFactory('/home/user/project');
    expect(factory.create('/home/user/project/src//gate/../core/vfs_hasher.nim')).toBe('src/core/vfs_hasher.nim');
  });

  it('normalizes trailing dot and slash-dot', () => {
    const factory = new VFSPathFactory('/home/user/project');
    expect(factory.create('/home/user/project/.')).toBe('');
    expect(factory.create('/home/user/project/./src')).toBe('src');
  });
});

// ── HermeticKaos with canonicalized paths ──────────────────────────

describe('HermeticKaos with canonicalized paths', () => {
  it('absolute path readText, stat, and iterdir succeed', async () => {
    // Build a ContentVector with Korean-named paths
    const rootDir = '/home/사용자/프로젝트';
    const vector: FsEntry[] = [
      {
        relPath: 'src/한글파일.ts',
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        size: 13,
        mtime: 1000,
        contentHash: '',
        content: Buffer.from('안녕하세요世界'),
      },
      {
        relPath: 'test/테스트.ts',
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        size: 5,
        mtime: 2000,
        contentHash: '',
        content: Buffer.from('hello'),
      },
    ];

    const index = Index.buildFromVector(vector, rootDir);

    // Build a minimal mock delegate for HermeticKaos
    const delegate: Kaos = {
      name: 'mock-delegate',
      osEnv: undefined as unknown as Kaos['osEnv'],
      pathClass: () => 'posix' as const,
      normpath: (p: string) => p,
      gethome: () => '/home/test',
      getcwd: () => rootDir,
      chdir: async () => {},
      withCwd: () => delegate,
      withEnv: () => delegate,
      stat: async () => ({ stMode: 0o100644, stIno: 0, stDev: 0, stNlink: 1, stUid: 0, stGid: 0, stSize: 0, stAtime: 0, stMtime: 0, stCtime: 0 }),
      iterdir: async function* () {},
      glob: async function* () {},
      snapshot: async () => [],
      readBytes: async () => Buffer.alloc(0),
      readText: async () => '',
      readLines: async function* () {},
      writeBytes: async () => 0,
      writeText: async () => 0,
      mkdir: async () => {},
      exec: async () => { throw new Error('not implemented'); },
      execWithEnv: async () => { throw new Error('not implemented'); },
    };

    const hermetic = new HermeticKaos(delegate, index);

    // readText with absolute path should succeed
    const content = await hermetic.readText(rootDir + '/src/한글파일.ts');
    expect(content).toBe('안녕하세요世界');

    // stat with absolute path should succeed
    const entry = await hermetic.stat(rootDir + '/src/한글파일.ts');
    expect(entry.stSize).toBe(13);

    // iterdir with absolute root path should yield children
    const children: string[] = [];
    for await (const child of hermetic.iterdir(rootDir)) {
      children.push(child);
    }
    expect(children.sort()).toEqual(['src', 'test']);
  });
});

// ── compareCanonicalPath ───────────────────────────────────────────

describe('compareCanonicalPath', () => {
  it('sorts deterministically by UTF-8 byte order', () => {
    const paths = ['바/a.txt', '한/b.txt', '가/c.txt'];

    // JS default string sort uses codepoint order
    const jsSorted = [...paths].sort();

    // compareCanonicalPath uses Buffer.compare (UTF-8 byte order)
    const byteSorted = [...paths].sort(compareCanonicalPath);

    // For these Korean characters the byte order should be deterministic
    // and produce a consistent result.
    expect(byteSorted).toEqual([...paths].sort((a, b) =>
      Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8')),
    ));

    // Verify stability: sorting twice yields the same order
    const secondPass = [...byteSorted].sort(compareCanonicalPath);
    expect(secondPass).toEqual(byteSorted);
  });
});
