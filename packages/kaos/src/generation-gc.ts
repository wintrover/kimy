import type { MerkleFileIndex } from './merkle-file-index';
import { ContentAddressedPool } from './object-pool';

// ── Public types ────────────────────────────────────────────────────

/** Result of a garbage collection pass. */
export interface GCResult {
  /** Number of unreachable objects removed from the pool. */
  readonly removedCount: number;
  /** Number of live objects remaining in the pool. */
  readonly remainingCount: number;
  /** Total bytes freed by the collection pass. */
  readonly freedBytes: number;
}

// ── GenerationGarbageCollector ──────────────────────────────────────

/**
 * Mark-sweep garbage collector for a {@link ContentAddressedPool}.
 *
 * The mark phase walks a {@link MerkleFileIndex} to discover every
 * content hash still referenced by live files.  The sweep phase
 * iterates the pool and removes every entry whose hash is **not**
 * in the live set, freeing memory.
 *
 * @example
 * ```ts
 * const gc = new GenerationGarbageCollector(pool);
 * const result = gc.collect(index);
 * console.log(`freed ${result.freedBytes} bytes`);
 * ```
 */
export class GenerationGarbageCollector {
  private readonly _pool: ContentAddressedPool;

  constructor(pool: ContentAddressedPool) {
    this._pool = pool;
  }

  /**
   * Mark phase — collect every content hash referenced by the index.
   *
   * Walks `index.files` and gathers each entry's `contentHash` into a
   * `Set`.  The resulting set represents the live set of objects that
   * must survive a sweep.
   *
   * @param index - The current file index to scan.
   * @returns A `Set<string>` of live content hashes.
   */
  mark(index: MerkleFileIndex): Set<string> {
    const liveHashes = new Set<string>();

    for (const entry of index.files.values()) {
      liveHashes.add(entry.contentHash);
    }

    return liveHashes;
  }

  /**
   * Sweep phase — remove every pool object not in `liveHashes`.
   *
   * Iterates every hash stored in the pool and deletes those that
   * are absent from the live set.  Reports the number of removed
   * entries, remaining entries, and total bytes freed.
   *
   * @param liveHashes - The set of hashes to keep (from {@link mark}).
   * @returns A {@link GCResult} summarising the collection pass.
   */
  sweep(liveHashes: Set<string>): GCResult {
    let removedCount = 0;
    let freedBytes = 0;

    // Collect hashes to remove first to avoid mutating during iteration.
    const toRemove: string[] = [];

    for (const hash of this._pool.keys()) {
      if (!liveHashes.has(hash)) {
        toRemove.push(hash);
      }
    }

    for (const hash of toRemove) {
      // Retrieve size before deleting so we can account for freed bytes.
      const buf = this._pool.get(hash);
      if (buf !== undefined) {
        freedBytes += buf.length;
      }
      if (this._pool.delete(hash)) {
        removedCount++;
      }
    }

    return {
      removedCount,
      remainingCount: this._pool.size,
      freedBytes,
    };
  }

  /**
   * Convenience — run mark then sweep in one call.
   *
   * @param index - The current file index to scan.
   * @returns A {@link GCResult} summarising the collection pass.
   */
  collect(index: MerkleFileIndex): GCResult {
    const liveHashes = this.mark(index);
    return this.sweep(liveHashes);
  }
}
