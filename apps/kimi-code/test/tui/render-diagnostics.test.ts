import { readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderDiagnostics } from '#/tui/render-diagnostics';

const ENV_KEY = 'KIMI_CODE_RENDER_DEBUG';
const DUMP_DIR = '/tmp/kimi-test-render-diagnostics';

describe('render-diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(DUMP_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('ring buffer', () => {
    it('wraps around and returns last N events', async () => {
      vi.stubEnv(ENV_KEY, '1');
      const { getDiagnostics } = await import('#/tui/render-diagnostics');
      const diag = getDiagnostics()!;

      for (let i = 0; i < 505; i++) {
        diag.record({
          type: 'request',
          caller: `caller-${i}`,
          force: false,
          depth: 0,
          suppressedCount: 0,
        });
      }

      // count caps at capacity (500)
      expect(diag.totalRecorded).toBe(500);
      const events = diag.getEvents();
      expect(events).toHaveLength(500);
      // oldest surviving event is index 5, newest is 504
      expect(events[0]!.caller).toBe('caller-5');
      expect(events[499]!.caller).toBe('caller-504');
    });

    it('returns events in insertion order', async () => {
      vi.stubEnv(ENV_KEY, '1');
      const { getDiagnostics } = await import('#/tui/render-diagnostics');
      const diag = getDiagnostics()!;

      diag.record({
        type: 'request',
        caller: 'a',
        force: false,
        depth: 0,
        suppressedCount: 0,
      });
      diag.record({
        type: 'suppress',
        caller: 'b',
        force: true,
        depth: 1,
        suppressedCount: 3,
      });
      diag.record({
        type: 'commit',
        caller: 'c',
        force: false,
        depth: 2,
        suppressedCount: 0,
      });

      const events = diag.getEvents();
      expect(events).toHaveLength(3);
      expect(events[0]!.type).toBe('request');
      expect(events[1]!.type).toBe('suppress');
      expect(events[2]!.type).toBe('commit');
    });
  });

  describe('isEnabled', () => {
    it('returns true when KIMI_CODE_RENDER_DEBUG=1', async () => {
      vi.stubEnv(ENV_KEY, '1');
      const { isEnabled } = await import('#/tui/render-diagnostics');
      expect(isEnabled()).toBe(true);
    });

    it('returns false when env var is unset', async () => {
      const { isEnabled } = await import('#/tui/render-diagnostics');
      expect(isEnabled()).toBe(false);
    });
  });

  describe('getDiagnostics', () => {
    it('returns same instance when enabled (singleton)', async () => {
      vi.stubEnv(ENV_KEY, '1');
      const { getDiagnostics } = await import('#/tui/render-diagnostics');
      const d1 = getDiagnostics();
      const d2 = getDiagnostics();
      expect(d1).toBe(d2);
      expect(d1).not.toBeNull();
    });

    it('returns instance even when disabled', async () => {
      const { getDiagnostics } = await import('#/tui/render-diagnostics');
      expect(getDiagnostics()).not.toBeNull();
    });
  });

  describe('dumpToFile', () => {
    it('writes valid JSONL with correct fields', async () => {
      vi.stubEnv(ENV_KEY, '1');
      const { getDiagnostics } = await import('#/tui/render-diagnostics');
      const diag = getDiagnostics()!;

      diag.record({
        type: 'request',
        caller: 'test-caller',
        force: true,
        depth: 2,
        suppressedCount: 5,
      });
      diag.record({
        type: 'flush',
        caller: 'other',
        force: false,
        depth: 0,
        suppressedCount: 0,
      });

      const filePath = diag.dumpToFile(DUMP_DIR);
      expect(filePath).toMatch(/\.jsonl$/);

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const event1 = JSON.parse(lines[0]!);
      expect(event1.type).toBe('request');
      expect(event1.caller).toBe('test-caller');
      expect(event1.force).toBe(true);
      expect(event1.depth).toBe(2);
      expect(event1.suppressedCount).toBe(5);
      expect(typeof event1.ts).toBe('number');

      const event2 = JSON.parse(lines[1]!);
      expect(event2.type).toBe('flush');
      expect(event2.caller).toBe('other');
    });
  });

  describe('captureCaller', () => {
    it('returns meaningful string with function name and file path', async () => {
      const { helperCaptureCaller } = await import('./_caller-helper');
      const result = helperCaptureCaller();

      expect(typeof result).toBe('string');
      expect(result).toContain('helperCaptureCaller');
      expect(result).toContain('/');
      expect(result).not.toContain('render-diagnostics');
      expect(result).not.toContain('render-transaction');
    });
  });

  describe('RenderEvent fields', () => {
    it('has all required fields with correct types', async () => {
      vi.stubEnv(ENV_KEY, '1');
      const { getDiagnostics } = await import('#/tui/render-diagnostics');
      const diag = getDiagnostics()!;

      diag.record({
        type: 'suppress',
        caller: 'test',
        force: true,
        depth: 3,
        suppressedCount: 7,
      });

      const events = diag.getEvents();
      expect(events).toHaveLength(1);
      const event = events[0]!;

      expect(typeof event.ts).toBe('number');
      expect(event.type).toBe('suppress');
      expect(typeof event.caller).toBe('string');
      expect(typeof event.force).toBe('boolean');
      expect(typeof event.depth).toBe('number');
      expect(typeof event.suppressedCount).toBe('number');
    });
  });

  describe('Invariant Detection', () => {
    const requestEvent = { type: 'request' as const, caller: 'test', force: false, depth: 0, suppressedCount: 0 };

    afterEach(() => {
      try {
        rmSync('/tmp/kimi-code', { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('returns Transaction Leak when streaming active and depth === 0', () => {
      const diag = new RenderDiagnostics();
      const result = diag.checkInvariant(
        { type: 'request', caller: 'test', force: false, depth: 0, suppressedCount: 0 },
        true,
      );
      expect(result).toBe('Transaction Leak');
    });

    it('returns Frame Multiplication when postCommit is true', () => {
      const diag = new RenderDiagnostics();
      diag.setPostCommit();
      const result = diag.checkInvariant(
        { type: 'request', caller: 'test', force: false, depth: 1, suppressedCount: 0 },
        false,
      );
      expect(result).toBe('Frame Multiplication');
    });

    it('returns null for normal request (not streaming, depth > 0)', () => {
      const diag = new RenderDiagnostics();
      const result = diag.checkInvariant(
        { type: 'request', caller: 'test', force: false, depth: 1, suppressedCount: 0 },
        false,
      );
      expect(result).toBeNull();
    });

    it('returns null for suppress events', () => {
      const diag = new RenderDiagnostics();
      const result = diag.checkInvariant(
        { type: 'suppress', caller: 'test', force: false, depth: 0, suppressedCount: 1 },
        true,
      );
      expect(result).toBeNull();
    });

    it('setPostCommit clears after process.nextTick', async () => {
      const diag = new RenderDiagnostics();
      diag.setPostCommit();

      // Immediately after setPostCommit, invariant should fire
      const before = diag.checkInvariant(
        { type: 'request', caller: 'test', force: false, depth: 1, suppressedCount: 0 },
        false,
      );
      expect(before).toBe('Frame Multiplication');

      // Wait for nextTick so the flag clears
      await new Promise<void>((r) => process.nextTick(r));

      const after = diag.checkInvariant(
        { type: 'request', caller: 'test', force: false, depth: 1, suppressedCount: 0 },
        false,
      );
      expect(after).toBeNull();
    });

    it('triggerAutoDump increments violationCount without stderr output', () => {
      const diag = new RenderDiagnostics();
      diag.record({
        type: 'request',
        caller: 'test',
        force: false,
        depth: 0,
        suppressedCount: 0,
      });

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      diag.triggerAutoDump('Test Violation');
      expect(diag.getViolationCount()).toBe(1);

      diag.triggerAutoDump('Another Violation');
      expect(diag.getViolationCount()).toBe(2);

      // No stderr output — logs go to file only
      expect(stderrSpy).not.toHaveBeenCalled();

      stderrSpy.mockRestore();
    });

    it('invariant check is skipped for non-request events', () => {
      const diag = new RenderDiagnostics();
      diag.setPostCommit();

      const flushResult = diag.checkInvariant(
        { type: 'flush', caller: 'test', force: false, depth: 0, suppressedCount: 0 },
        true,
      );
      expect(flushResult).toBeNull();

      const commitResult = diag.checkInvariant(
        { type: 'commit', caller: 'test', force: false, depth: 0, suppressedCount: 0 },
        true,
      );
      expect(commitResult).toBeNull();
    });
  });
});
