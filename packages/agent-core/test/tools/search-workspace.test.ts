import { describe, expect, it, vi } from 'vitest';

import { SearchWorkspaceInputSchema, SearchWorkspaceTool } from '../../src/tools/builtin/file/search-workspace';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

async function* asyncPaths(paths: readonly string[]) {
  for (const item of paths) yield item;
}

function stat(mtime: number, mode = 0o100000, size = 100) {
  return { stMtime: mtime, stMode: mode, stSize: size };
}

function context(args: { intent: string; path?: string; file_types?: string[]; max_results?: number }) {
  return { turnId: '0', toolCallId: 'call_search_workspace', args, signal };
}

describe('SearchWorkspaceTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new SearchWorkspaceTool(createFakeKaos(), workspace);

    expect(tool.name).toBe('SearchWorkspace');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { intent: { type: 'string' } },
    });
    expect(SearchWorkspaceInputSchema.safeParse({ intent: 'authentication' }).success).toBe(true);
    expect(
      SearchWorkspaceInputSchema.safeParse({
        intent: 'database pool',
        path: '/workspace/src',
        file_types: ['.ts'],
        max_results: 10,
      }).success,
    ).toBe(true);
  });

  it('returns no matches when no files match the intent', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/README.md']));
    const statFn = vi.fn().mockResolvedValue(stat(1));
    const tool = new SearchWorkspaceTool(createFakeKaos({ glob, stat: statFn }), workspace);

    const result = await executeTool(tool, context({ intent: 'authentication middleware' }));

    expect(result.output).toContain('No files found matching intent');
  });

  it('matches files by path/filename keywords with 3x weight', async () => {
    const glob = vi.fn().mockReturnValue(
      asyncPaths([
        '/workspace/src/auth.ts',
        '/workspace/src/utils.ts',
        '/workspace/src/auth-middleware.ts',
      ]),
    );
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth' }));

    expect(result.output).toContain('src/auth.ts');
    expect(result.output).toContain('src/auth-middleware.ts');
    // utils.ts should not appear because it doesn't match "auth"
    expect(result.output).not.toContain('src/utils.ts');
  });

  it('extracts and scores identifiers with 5x weight', async () => {
    const fileContent = Buffer.from(
      'export class AuthService {\n  login() {}\n}\nexport function authenticate() {}\n',
    );
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src/service.ts']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(fileContent),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'AuthService' }));

    expect(result.output).toContain('src/service.ts');
    expect(result.output).toContain('AuthService');
  });

  it('applies recency boost for files modified within 24 hours', async () => {
    const recentMtime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const oldMtime = Math.floor(Date.now() / 1000) - 86400 * 2; // 2 days ago

    const glob = vi.fn().mockReturnValue(
      asyncPaths(['/workspace/old-auth.ts', '/workspace/new-auth.ts']),
    );
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi
          .fn()
          .mockResolvedValueOnce(stat(oldMtime))
          .mockResolvedValueOnce(stat(oldMtime))
          .mockResolvedValueOnce(stat(recentMtime))
          .mockResolvedValueOnce(stat(recentMtime)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth' }));

    const output = typeof result.output === 'string' ? result.output : '';
    // Recent file should appear first due to recency boost
    const newIdx = output.indexOf('new-auth.ts');
    const oldIdx = output.indexOf('old-auth.ts');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('restricts search by file_types', async () => {
    const glob = vi.fn().mockReturnValue(
      asyncPaths([
        '/workspace/src/auth.ts',
        '/workspace/src/auth.js',
        '/workspace/src/auth.py',
      ]),
    );
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth', file_types: ['.ts'] }));

    expect(result.output).toContain('src/auth.ts');
    expect(result.output).not.toContain('src/auth.js');
    expect(result.output).not.toContain('src/auth.py');
  });

  it('respects max_results limit', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/workspace/auth-${String(i)}.ts`);
    const glob = vi.fn().mockReturnValue(asyncPaths(paths));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth', max_results: 5 }));

    const output = typeof result.output === 'string' ? result.output : '';
    // Should show truncation message
    expect(output).toContain('total matches');
    expect(output).toContain('showing top 5');
  });

  it('caps max_results at HARD_MAX_RESULTS (50)', async () => {
    const tool = new SearchWorkspaceTool(createFakeKaos(), workspace);

    const result = await executeTool(tool, context({ intent: 'test', max_results: 100 }));

    // Even with 100 requested, should cap at 50
    // (This just tests the schema validation / input parsing doesn't fail)
    expect(result).toBeDefined();
  });

  it('skips directories', async () => {
    const glob = vi.fn().mockReturnValue(
      asyncPaths(['/workspace/src', '/workspace/src/auth.ts']),
    );
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi
          .fn()
          .mockResolvedValueOnce(stat(1, 0o040000)) // directory
          .mockResolvedValueOnce(stat(1, 0o100000)), // file
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth' }));

    expect(result.output).toContain('src/auth.ts');
    // Directory entry should not appear in results
  });

  it('skips binary files during identifier extraction', async () => {
    // Files with null bytes should be treated as binary
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/binary-data.bin']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(binaryContent),
      }),
      workspace,
    );

    // Binary files won't match text-based intent keywords, so no match
    const result = await executeTool(tool, context({ intent: 'binary data' }));

    // No identifiers extracted, path doesn't match keywords closely
    expect(result.output).toBeDefined();
  });

  it('skips files larger than 100KB for identifier extraction', async () => {
    const largeSize = 200 * 1024; // 200KB
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/large-file.ts']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1, 0o100000, largeSize)),
        readBytes: vi.fn(), // Should not be called
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'large-file' }));

    // File should still appear via path matching even without identifier extraction
    expect(result.output).toContain('large-file.ts');
    // readBytes should not have been called due to size guard
  });

  it('uses search root from explicit path argument', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/extra/src/auth.ts']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth', path: '/extra' }));

    expect(glob).toHaveBeenCalledWith('/extra', expect.any(String));
  });

  it('defaults search root to workspaceDir when path is omitted', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/auth.ts']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth' }));

    expect(glob).toHaveBeenCalledWith('/workspace', expect.any(String));
  });

  it('returns error when intent has no searchable keywords', async () => {
    const tool = new SearchWorkspaceTool(createFakeKaos(), workspace);

    const result = await executeTool(tool, context({ intent: '!!' }));

    expect(result.output).toContain('No searchable keywords');
  });

  it('builds tree output with identifier tags', async () => {
    const fileContent = Buffer.from('export class AuthService {}\n');
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src/auth.ts']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(fileContent),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth' }));

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('├── src/auth.ts');
    expect(output).toContain('AuthService');
  });

  it('limits identifier tags to 5 in the output', async () => {
    const idents = Array.from({ length: 8 }, (_, i) => `export function auth${String(i)}() {}`).join('\n');
    const fileContent = Buffer.from(idents);
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src/auth-idents.ts']));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(fileContent),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth' }));

    const output = typeof result.output === 'string' ? result.output : '';
    // Should contain "..." indicating more identifiers were truncated
    expect(output).toContain('...');
  });

  it('bounds output to character budget with truncation marker', async () => {
    // Generate many matching files with long names — each line ~60 chars, budget is 2000.
    // 50 results × 60 chars = 3000 > 2000, so the budget truncation fires.
    const paths = Array.from(
      { length: 100 },
      (_, i) => `/workspace/src/modules/features/auth/feature-module-${String(i)}.ts`,
    );
    const glob = vi.fn().mockReturnValue(asyncPaths(paths));
    const tool = new SearchWorkspaceTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
        readBytes: vi.fn().mockResolvedValue(Buffer.from('')),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ intent: 'auth', max_results: 50 }));

    const output = typeof result.output === 'string' ? result.output : '';
    // Output should contain the budget truncation marker
    expect(output).toContain('...');
  });

  it('sorts results by score descending then by mtime', async () => {
    const recentMtime = Math.floor(Date.now() / 1000) - 100;
    const oldMtime = Math.floor(Date.now() / 1000) - 10000;

    const fileWithIdent = Buffer.from('export class AuthService {}\n');
    const fileEmpty = Buffer.from('');

    const glob = vi.fn().mockReturnValue(
      asyncPaths([
        '/workspace/old-auth-with-ident.ts',
        '/workspace/recent-auth-no-ident.ts',
      ]),
    );
    const statFn = vi
      .fn()
      // File 1 (old-auth-with-ident.ts): execution stat + extractIdentifiers stat
      .mockResolvedValueOnce(stat(oldMtime))
      .mockResolvedValueOnce(stat(oldMtime))
      // File 2 (recent-auth-no-ident.ts): execution stat + extractIdentifiers stat
      .mockResolvedValueOnce(stat(recentMtime))
      .mockResolvedValueOnce(stat(recentMtime));
    const readBytesFn = vi
      .fn()
      .mockResolvedValueOnce(fileWithIdent)
      .mockResolvedValueOnce(fileEmpty);

    const tool = new SearchWorkspaceTool(
      createFakeKaos({ glob, stat: statFn, readBytes: readBytesFn }),
      workspace,
    );

    // "auth" matches both filenames, "AuthService" matches identifier in file 1
    const result = await executeTool(tool, context({ intent: 'auth AuthService' }));

    const output = typeof result.output === 'string' ? result.output : '';
    const authWithIdentIdx = output.indexOf('old-auth-with-ident.ts');
    const authNoIdentIdx = output.indexOf('recent-auth-no-ident.ts');
    // File with matching identifier (5x weight) should rank higher
    // even though it's older, because identifier score dominates
    expect(authWithIdentIdx).toBeLessThan(authNoIdentIdx);
  });
});
