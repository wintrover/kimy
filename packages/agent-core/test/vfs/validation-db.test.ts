import { describe, it, expect } from 'vitest';
import { ValidationDatabase, stableHash } from '#/vfs/validation-db';
import type { VerificationResult, SynthesisResult } from '#/vfs/validation-db';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeVerificationResult(
  overrides?: Partial<VerificationResult>,
): VerificationResult {
  return {
    valid: true,
    rlimitUsed: 1000,
    durationMs: 42,
    durability: 'HIGH',
    ...overrides,
  };
}

function makeSynthesisResult(
  overrides?: Partial<SynthesisResult>,
): SynthesisResult {
  return {
    success: true,
    synthesized: '(λ (x) x)',
    rlimitUsed: 2000,
    durationMs: 80,
    durability: 'HIGH',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// memoKey
// ---------------------------------------------------------------------------

describe('memoKey', () => {
  it('same inputs → same key (deterministic)', () => {
    const db = new ValidationDatabase();
    const k1 = db.memoKey('/foo/bar.nif', 3, 10000);
    const k2 = db.memoKey('/foo/bar.nif', 3, 10000);
    expect(k1).toBe(k2);
  });

  it('different epoch → different key', () => {
    const db = new ValidationDatabase();
    const k1 = db.memoKey('/foo/bar.nif', 1, 10000);
    const k2 = db.memoKey('/foo/bar.nif', 2, 10000);
    expect(k1).not.toBe(k2);
  });

  it('different path → different key', () => {
    const db = new ValidationDatabase();
    const k1 = db.memoKey('/a.nif', 1, 10000);
    const k2 = db.memoKey('/b.nif', 1, 10000);
    expect(k1).not.toBe(k2);
  });

  it('different rlimit → different key', () => {
    const db = new ValidationDatabase();
    const k1 = db.memoKey('/foo/bar.nif', 1, 10000);
    const k2 = db.memoKey('/foo/bar.nif', 1, 20000);
    expect(k1).not.toBe(k2);
  });

  it('returns 16-char hex string', () => {
    const db = new ValidationDatabase();
    const key = db.memoKey('/foo/bar.nif', 1, 10000);
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// stableHash
// ---------------------------------------------------------------------------

describe('stableHash', () => {
  it('same content → same hash (deterministic)', () => {
    const h1 = stableHash('hello world');
    const h2 = stableHash('hello world');
    expect(h1).toBe(h2);
  });

  it('different content → different hash', () => {
    const h1 = stableHash('hello');
    const h2 = stableHash('world');
    expect(h1).not.toBe(h2);
  });

  it('returns full SHA-256 hex (64 chars)', () => {
    const h = stableHash('test');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// cache_z3Verify + query_z3Verify
// ---------------------------------------------------------------------------

describe('cache_z3Verify + query_z3Verify', () => {
  it('cache miss → returns null', () => {
    const db = new ValidationDatabase();
    const result = db.query_z3Verify('contractA', 'mutA', 10000, 1);
    expect(result).toBeNull();
  });

  it('cache then query → returns cached result', () => {
    const db = new ValidationDatabase();
    const expected = makeVerificationResult({ valid: true });
    db.cache_z3Verify('contractA', 'mutA', 10000, expected, 1);
    const result = db.query_z3Verify('contractA', 'mutA', 10000, 1);
    expect(result).toEqual(expected);
  });

  it('different contractHash → cache miss', () => {
    const db = new ValidationDatabase();
    const expected = makeVerificationResult();
    db.cache_z3Verify('contractA', 'mutA', 10000, expected, 1);
    const result = db.query_z3Verify('contractB', 'mutA', 10000, 1);
    expect(result).toBeNull();
  });

  it('same key, different epoch → cache hit for HIGH, miss for LOW', () => {
    const db = new ValidationDatabase();

    // HIGH durability: cached at epoch 1, queried at epoch 5 → hit
    db.cache_z3Verify('c', 'm', 10000, makeVerificationResult({ durability: 'HIGH' }), 1);
    expect(db.query_z3Verify('c', 'm', 10000, 5)).not.toBeNull();

    // LOW durability: cached at epoch 1, queried at epoch 2 → miss
    db.cache_z3Verify('c2', 'm2', 10000, makeVerificationResult({ durability: 'LOW' }), 1);
    expect(db.query_z3Verify('c2', 'm2', 10000, 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Durability classes (verify)
// ---------------------------------------------------------------------------

describe('Durability classes', () => {
  it('LOW durability entry → evicted when epoch changes', () => {
    const db = new ValidationDatabase();
    db.cache_z3Verify('c', 'm', 100, makeVerificationResult({ durability: 'LOW' }), 1);
    // Same epoch → hit
    expect(db.query_z3Verify('c', 'm', 100, 1)).not.toBeNull();
    // Different epoch → miss (evicted lazily)
    expect(db.query_z3Verify('c', 'm', 100, 2)).toBeNull();
  });

  it('HIGH durability entry → persists across epoch changes', () => {
    const db = new ValidationDatabase();
    const expected = makeVerificationResult({ durability: 'HIGH' });
    db.cache_z3Verify('c', 'm', 100, expected, 1);
    // Different epoch → still hit
    expect(db.query_z3Verify('c', 'm', 100, 999)).toEqual(expected);
  });

  it('LOW durability entry → fresh when same epoch', () => {
    const db = new ValidationDatabase();
    const expected = makeVerificationResult({ durability: 'LOW' });
    db.cache_z3Verify('c', 'm', 100, expected, 5);
    expect(db.query_z3Verify('c', 'm', 100, 5)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// invalidateEpoch
// ---------------------------------------------------------------------------

describe('invalidateEpoch', () => {
  it('invalidates LOW entries for specific epoch', () => {
    const db = new ValidationDatabase();
    db.cache_z3Verify('c', 'm', 10, makeVerificationResult({ durability: 'LOW' }), 3);
    db.invalidateEpoch(3);
    expect(db.query_z3Verify('c', 'm', 10, 3)).toBeNull();
  });

  it('does NOT invalidate HIGH entries', () => {
    const db = new ValidationDatabase();
    const expected = makeVerificationResult({ durability: 'HIGH' });
    db.cache_z3Verify('c', 'm', 10, expected, 3);
    db.invalidateEpoch(3);
    expect(db.query_z3Verify('c', 'm', 10, 3)).toEqual(expected);
  });

  it('does NOT invalidate LOW entries for other epochs', () => {
    const db = new ValidationDatabase();
    const expected = makeVerificationResult({ durability: 'LOW' });
    db.cache_z3Verify('c', 'm', 10, expected, 1);
    // Invalidate epoch 2, not 1
    db.invalidateEpoch(2);
    expect(db.query_z3Verify('c', 'm', 10, 1)).toEqual(expected);
  });

  it('double invalidation → idempotent', () => {
    const db = new ValidationDatabase();
    db.cache_z3Verify('c', 'm', 10, makeVerificationResult({ durability: 'LOW' }), 5);
    db.invalidateEpoch(5);
    // Second call should not throw
    expect(() => db.invalidateEpoch(5)).not.toThrow();
    // Entry already gone
    expect(db.query_z3Verify('c', 'm', 10, 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cache_z3Synthesize + query_z3Synthesize
// ---------------------------------------------------------------------------

describe('cache_z3Synthesize + query_z3Synthesize', () => {
  it('cache miss → null', () => {
    const db = new ValidationDatabase();
    expect(db.query_z3Synthesize('sketchA', 10000, 1)).toBeNull();
  });

  it('cache then query → returns cached result', () => {
    const db = new ValidationDatabase();
    const expected = makeSynthesisResult();
    db.cache_z3Synthesize('sketchA', 10000, expected, 1);
    expect(db.query_z3Synthesize('sketchA', 10000, 1)).toEqual(expected);
  });

  it('durability classes apply same as verify cache', () => {
    const db = new ValidationDatabase();

    // HIGH: persists across epochs
    const high = makeSynthesisResult({ durability: 'HIGH' });
    db.cache_z3Synthesize('s', 100, high, 1);
    expect(db.query_z3Synthesize('s', 100, 999)).toEqual(high);

    // LOW: evicted on epoch mismatch
    const low = makeSynthesisResult({ durability: 'LOW' });
    db.cache_z3Synthesize('s2', 100, low, 1);
    expect(db.query_z3Synthesize('s2', 100, 2)).toBeNull();
    // Same epoch still works
    db.cache_z3Synthesize('s2', 100, low, 1);
    expect(db.query_z3Synthesize('s2', 100, 1)).toEqual(low);
  });
});
