import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Durability classification
// ---------------------------------------------------------------------------

/**
 * Durability class for cached validation results.
 *
 * - `HIGH`: type signatures, effect pragmas from NIF — derived from source
 *   metadata that changes infrequently. Cache survives across epochs unless
 *   the specific symbol is modified.
 * - `LOW`: function bodies — volatile content that changes frequently. Cache
 *   entries are aggressively evicted on epoch transitions.
 */
export type DurabilityClass = 'HIGH' | 'LOW';

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/**
 * A mutation that carries a proof of correctness (Salsa-style).
 *
 * A `ProofCarryingMutation` is a proposed transformation that includes a
 * formal witness (proof term, type witness, or invariant witness) attesting
 * that the mutation preserves the contract's invariants.
 */
export interface ProofCarryingMutation {
  /** Stable hash of the mutation payload (the code change itself). */
  readonly mutationHash: string;
  /** The proof witness that accompanies this mutation. */
  readonly proofWitness: string;
  /** Durability classification for this mutation. */
  readonly durability: DurabilityClass;
  /** The original contract this mutation targets. */
  readonly contractHash: string;
}

/**
 * An incomplete synthesis target — a partial proof or implementation sketch
 * that the Z3 synthesizer fills in.
 */
export interface Sketch {
  /** Stable hash of the sketch template. */
  readonly sketchHash: string;
  /** The hole/placeholder descriptions the synthesizer must fill. */
  readonly holes: readonly string[];
  /** Constraints the synthesized result must satisfy. */
  readonly constraints: readonly string[];
  /** Durability classification for the sketch. */
  readonly durability: DurabilityClass;
}

/**
 * Result of a Z3 verification query.
 */
export interface VerificationResult {
  /** Whether the mutation preserves all contract invariants. */
  readonly valid: boolean;
  /** Counterexample if the verification failed, `undefined` on success. */
  readonly counterexample?: string | undefined;
  /** Z3 resource usage in the verification run. */
  readonly rlimitUsed: number;
  /** Duration of the Z3 query in milliseconds. */
  readonly durationMs: number;
  /** The durability class of the cached entry. */
  readonly durability: DurabilityClass;
}

/**
 * Result of a Z3 synthesis query.
 */
export interface SynthesisResult {
  /** Whether synthesis succeeded (found a valid completion). */
  readonly success: boolean;
  /** The synthesized code/proof term, if successful. */
  readonly synthesized?: string | undefined;
  /** Z3 resource usage in the synthesis run. */
  readonly rlimitUsed: number;
  /** Duration of the Z3 query in milliseconds. */
  readonly durationMs: number;
  /** The durability class of the cached entry. */
  readonly durability: DurabilityClass;
}

// ---------------------------------------------------------------------------
// Internal cache entry types
// ---------------------------------------------------------------------------

interface VerifyCacheEntry {
  readonly result: VerificationResult;
  readonly epoch: number;
  readonly durability: DurabilityClass;
}

interface SynthesizeCacheEntry {
  readonly result: SynthesisResult;
  readonly epoch: number;
  readonly durability: DurabilityClass;
}

// ---------------------------------------------------------------------------
// ValidationDatabase
// ---------------------------------------------------------------------------

/**
 * Salsa-style memoized validation database for the deterministic agent
 * architecture.
 *
 * Every memoization key embeds the Z3 `rlimit` so that re-evaluation with a
 * different resource bound always produces a fresh result, while re-evaluation
 * with the **same** rlimit hits the cache immediately.
 *
 * Cache entries are classified by durability:
 * - `HIGH` entries (type signatures, effect pragmas from NIF) persist across
 *   epoch transitions unless explicitly invalidated.
 * - `LOW` entries (function bodies) are evicted on every `invalidateEpoch`
 *   call for the matching epoch.
 *
 * Determinism guarantee: `same(contractHash, mutationHash, rlimit) → same
 * result` — the memo key is a deterministic hash of those three values.
 */
export class ValidationDatabase {
  private verifyCache = new Map<string, VerifyCacheEntry>();
  private synthesizeCache = new Map<string, SynthesizeCacheEntry>();

  // ----- Key generation -----

  /**
   * Generate a deterministic memoization key from a file path, epoch, and
   * Z3 rlimit. The key is a SHA-256 digest (truncated to 16 hex chars) of
   * the canonical string `path\x00epoch\x00rlimit`.
   *
   * Including `rlimit` in the key ensures that:
   * - Same inputs + same rlimit → cache hit
   * - Same inputs + different rlimit → cache miss (different resource bound
   *   may produce different results)
   */
  memoKey(path: string, epoch: number, rlimit: number): string {
    const canonical = `${path}\x00${String(epoch)}\x00${String(rlimit)}`;
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  // ----- Verification queries -----

  /**
   * Look up a cached verification result.
   *
   * Returns `null` on cache miss. A hit requires that:
   * 1. The exact `(contractHash, mutationHash, rlimit)` key exists.
   * 2. The entry's epoch matches the current epoch (for LOW durability),
   *    or the entry is HIGH durability (epoch-agnostic).
   * 3. The entry is not stale due to an `invalidateEpoch` call.
   */
  query_z3Verify(
    contractHash: string,
    mutationHash: string,
    rlimit: number,
    currentEpoch: number,
  ): VerificationResult | null {
    const key = this.verifyMemoKey(contractHash, mutationHash, rlimit);
    const entry = this.verifyCache.get(key);
    if (entry === undefined) return null;
    if (!isCacheFresh(entry.epoch, entry.durability, currentEpoch)) {
      this.verifyCache.delete(key);
      return null;
    }
    return entry.result;
  }

  /**
   * Store a verification result in the cache.
   */
  cache_z3Verify(
    contractHash: string,
    mutationHash: string,
    rlimit: number,
    result: VerificationResult,
    epoch: number,
  ): void {
    const key = this.verifyMemoKey(contractHash, mutationHash, rlimit);
    this.verifyCache.set(key, {
      result,
      epoch,
      durability: result.durability,
    });
  }

  // ----- Synthesis queries -----

  /**
   * Look up a cached synthesis result.
   *
   * Returns `null` on cache miss. Follows the same freshness rules as
   * `query_z3Verify`.
   */
  query_z3Synthesize(
    sketchHash: string,
    rlimit: number,
    currentEpoch: number,
  ): SynthesisResult | null {
    const key = this.synthesizeMemoKey(sketchHash, rlimit);
    const entry = this.synthesizeCache.get(key);
    if (entry === undefined) return null;
    if (!isCacheFresh(entry.epoch, entry.durability, currentEpoch)) {
      this.synthesizeCache.delete(key);
      return null;
    }
    return entry.result;
  }

  /**
   * Store a synthesis result in the cache.
   */
  cache_z3Synthesize(
    sketchHash: string,
    rlimit: number,
    result: SynthesisResult,
    epoch: number,
  ): void {
    const key = this.synthesizeMemoKey(sketchHash, rlimit);
    this.synthesizeCache.set(key, {
      result,
      epoch,
      durability: result.durability,
    });
  }

  // ----- Epoch management -----

  /**
   * Invalidate cache entries for a given epoch.
   *
   * - `LOW` durability entries created at `epoch` are evicted.
   * - `HIGH` durability entries are preserved regardless of epoch.
   *
   * This implements the Salsa-style staleness model: function bodies change
   * often (LOW) and must be re-verified, while type signatures and effect
   * pragmas (HIGH) are stable across minor refactors.
   */
  invalidateEpoch(epoch: number): void {
    evictByEpoch(this.verifyCache, epoch);
    evictByEpoch(this.synthesizeCache, epoch);
  }

  // ----- Internal key builders -----

  private verifyMemoKey(contractHash: string, mutationHash: string, rlimit: number): string {
    const canonical = `verify\x00${contractHash}\x00${mutationHash}\x00${String(rlimit)}`;
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  private synthesizeMemoKey(sketchHash: string, rlimit: number): string {
    const canonical = `synthesize\x00${sketchHash}\x00${String(rlimit)}`;
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a cache entry is still fresh given the current epoch.
 *
 * - HIGH durability entries are epoch-agnostic (always fresh).
 * - LOW durability entries are fresh only if their epoch matches the current
 *   epoch.
 */
function isCacheFresh(
  entryEpoch: number,
  durability: DurabilityClass,
  currentEpoch: number,
): boolean {
  if (durability === 'HIGH') return true;
  return entryEpoch === currentEpoch;
}

/**
 * Evict all LOW-durability entries matching the given epoch from a cache map.
 */
function evictByEpoch<K>(
  cache: Map<string, { readonly epoch: number; readonly durability: DurabilityClass } & K>,
  epoch: number,
): void {
  for (const [key, entry] of cache) {
    if (entry.epoch === epoch && entry.durability === 'LOW') {
      cache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

/**
 * Compute a stable SHA-256 hash of a string for use as a contract or
 * mutation hash in the ValidationDatabase.
 */
export function stableHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
