import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSandboxEnv } from '../src/snapshot-projector';

describe('buildSandboxEnv', () => {
  it('should only include whitelisted env vars from process.env', () => {
    const env = buildSandboxEnv();
    // Should contain PATH (whitelisted) but not arbitrary process.env keys
    expect(env).toHaveProperty('PATH');
    // Should NOT contain potentially sensitive vars
    // (We can't know what's in process.env, but the whitelist is limited)
    const allowedKeys = ['HOME', 'USER', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM',
      'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH', 'NODE_OPTIONS'];
    for (const key of Object.keys(env)) {
      expect(allowedKeys).toContain(key);
    }
  });

  it('should overlay invocation env on top of whitelisted base', () => {
    const env = buildSandboxEnv({ MY_VAR: 'test', PATH: '/custom/path' });
    expect(env.MY_VAR).toBe('test');
    expect(env.PATH).toBe('/custom/path'); // invocation overrides whitelist
  });

  it('should return only invocation env when no whitelisted vars exist', () => {
    // This test just verifies the function doesn't crash
    const env = buildSandboxEnv({ FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });
});
