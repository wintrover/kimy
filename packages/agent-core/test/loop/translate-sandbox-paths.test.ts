import { describe, expect, it } from 'vitest';

import { translateSandboxPaths } from '../../src/loop/tool-call';

describe('translateSandboxPaths', () => {
  const sandboxRoot = '/workspace';
  const hostRoot = '/home/user/project';

  it('translates basic sandbox paths to host paths', () => {
    const input = 'error in /workspace/src/main.ts:10:5';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    expect(result).toBe('error in /home/user/project/src/main.ts:10:5');
  });

  it('translates double-slash sandbox paths', () => {
    const input = '//workspace/packages/foo.ts';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    expect(result).toBe('/home/user/project/packages/foo.ts');
  });

  it('returns output unchanged when sandboxRoot is empty', () => {
    const input = 'error in /workspace/src/main.ts';
    const result = translateSandboxPaths(input, '', hostRoot);
    expect(result).toBe(input);
  });

  it('returns output unchanged when hostRoot is empty', () => {
    const input = 'error in /workspace/src/main.ts';
    const result = translateSandboxPaths(input, sandboxRoot, '');
    expect(result).toBe(input);
  });

  it('returns output unchanged when sandboxRoot === hostRoot', () => {
    const input = 'error in /workspace/src/main.ts';
    const result = translateSandboxPaths(input, '/workspace', '/workspace');
    expect(result).toBe(input);
  });

  it('translates multiple occurrences in one output', () => {
    const input = 'files: /workspace/a.ts and /workspace/b.ts and //workspace/c.ts';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    expect(result).toBe(
      'files: /home/user/project/a.ts and /home/user/project/b.ts and /home/user/project/c.ts',
    );
  });

  it('translates bare /workspace without trailing path', () => {
    const input = 'chdir to /workspace';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    expect(result).toBe('chdir to /home/user/project');
  });

  it('does not match paths inside quotes with spaces', () => {
    const input = 'echo "hello world" > /workspace/out.txt';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    // /workspace/out.txt should match (no spaces in path portion)
    expect(result).toBe('echo "hello world" > /home/user/project/out.txt');
  });

  it('does not match partial word boundaries like xworkspace', () => {
    const input = 'error in /xworkspace/src/main.ts';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    expect(result).toBe(input);
  });

  it('handles nested paths with multiple segments', () => {
    const input = '/workspace/packages/agent-core/src/loop/tool-call.ts:42';
    const result = translateSandboxPaths(input, sandboxRoot, hostRoot);
    expect(result).toBe('/home/user/project/packages/agent-core/src/loop/tool-call.ts:42');
  });
});
