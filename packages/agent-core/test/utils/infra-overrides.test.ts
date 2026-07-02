import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadLearnedConstraints,
  persistLearnedConstraint,
  mergeConstraints,
} from '../../src/utils/infra-overrides';
import type { LearnedConstraints } from '../../src/utils/infra-overrides';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = join(
    tmpdir(),
    `kimi-infra-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const OVERRIDES_FILE = 'infra-overrides.json';

describe('loadLearnedConstraints', () => {
  it('returns empty object when file does not exist', async () => {
    expect(await loadLearnedConstraints(tmpRoot)).toEqual({});
  });

  it('returns empty object when directory does not exist', async () => {
    const nonExistent = join(tmpdir(), `no-such-dir-${Date.now()}`);
    expect(await loadLearnedConstraints(nonExistent)).toEqual({});
  });

  it('returns empty object on corrupt JSON', async () => {
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(join(tmpRoot, OVERRIDES_FILE), 'not json', 'utf-8');
    expect(await loadLearnedConstraints(tmpRoot)).toEqual({});
  });

  it('returns parsed content on valid JSON', async () => {
    const data: LearnedConstraints = {
      'provider-a': { output: 4096, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(
      join(tmpRoot, OVERRIDES_FILE),
      JSON.stringify(data),
      'utf-8',
    );
    expect(await loadLearnedConstraints(tmpRoot)).toEqual(data);
  });
});

describe('persistLearnedConstraint + loadLearnedConstraints (round-trip)', () => {
  it('writes and reads a learned constraint', async () => {
    await persistLearnedConstraint(tmpRoot, 'my-provider', 8192);
    const loaded = await loadLearnedConstraints(tmpRoot);
    expect(loaded['my-provider']).toBeDefined();
    expect(loaded['my-provider']!.output).toBe(8192);
    expect(typeof loaded['my-provider']!.learnedAt).toBe('string');
  });

  it('overwrites previous value for the same provider', async () => {
    await persistLearnedConstraint(tmpRoot, 'my-provider', 8192);
    await persistLearnedConstraint(tmpRoot, 'my-provider', 4096);
    const loaded = await loadLearnedConstraints(tmpRoot);
    expect(loaded['my-provider']!.output).toBe(4096);
  });

  it('preserves multiple providers independently', async () => {
    await persistLearnedConstraint(tmpRoot, 'p1', 1000);
    await persistLearnedConstraint(tmpRoot, 'p2', 2000);
    const loaded = await loadLearnedConstraints(tmpRoot);
    expect(loaded['p1']!.output).toBe(1000);
    expect(loaded['p2']!.output).toBe(2000);
  });

  it('produces valid JSON on disk', async () => {
    await persistLearnedConstraint(tmpRoot, 'p', 1234);
    const raw = await readFile(join(tmpRoot, OVERRIDES_FILE), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['p']?.output).toBe(1234);
  });
});

describe('mergeConstraints', () => {
  it('returns static constraints when there are no learned constraints', () => {
    const static_ = { p1: { output: 4096 } };
    expect(mergeConstraints(static_, {})).toEqual({ p1: { output: 4096 } });
  });

  it('returns learned constraints when there are no static constraints', () => {
    const learned: LearnedConstraints = {
      p1: { output: 8192, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(mergeConstraints({}, learned)).toEqual({ p1: { output: 8192 } });
  });

  it('uses the minimum when both static and learned have the same provider', () => {
    const static_ = { p1: { output: 4096 } };
    const learned: LearnedConstraints = {
      p1: { output: 8192, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(mergeConstraints(static_, learned)).toEqual({ p1: { output: 4096 } });
  });

  it('returns the union of providers when they differ', () => {
    const static_ = { p1: { output: 4096 } };
    const learned: LearnedConstraints = {
      p2: { output: 8192, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(mergeConstraints(static_, learned)).toEqual({
      p1: { output: 4096 },
      p2: { output: 8192 },
    });
  });

  it('learned wins when it is lower than static', () => {
    const static_ = { p1: { output: 16384 } };
    const learned: LearnedConstraints = {
      p1: { output: 4096, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(mergeConstraints(static_, learned)).toEqual({ p1: { output: 4096 } });
  });

  it('static wins when it is lower than learned', () => {
    const static_ = { p1: { output: 4096 } };
    const learned: LearnedConstraints = {
      p1: { output: 16384, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(mergeConstraints(static_, learned)).toEqual({ p1: { output: 4096 } });
  });

  it('ignores learned entries without an output limit', () => {
    const static_ = { p1: { output: 4096 } };
    const learned: LearnedConstraints = {
      p1: { output: undefined, learnedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(mergeConstraints(static_, learned)).toEqual({ p1: { output: 4096 } });
  });
});
