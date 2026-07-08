import { createHash } from 'node:crypto';

/**
 * Statistics about a {@link ContentAddressedPool}.
 */
export interface PoolStats {
  /** Total number of unique objects stored. */
  objectCount: number;
  /** Total bytes of unique content stored. */
  totalBytes: number;
}

/**
 * Content-addressed object pool.
 *
 * Stores arbitrary binary objects keyed by their SHA-256 digest.
 * Identical content is deduplicated — a second `put()` of the same bytes
 * returns the same hash without storing a duplicate copy.
 */
export class ContentAddressedPool {
  private readonly _objects = new Map<string, Buffer>();
  private _totalBytes = 0;

  /**
   * Store content in the pool and return its SHA-256 hex digest.
   *
   * If the same content has already been stored, the existing hash is
   * returned and no additional memory is allocated.
   *
   * @param data - The raw bytes to store.
   * @returns The hex-encoded SHA-256 digest of `data`.
   */
  put(data: Buffer): string {
    const hash = sha256Hex(data);

    if (!this._objects.has(hash)) {
      this._objects.set(hash, data);
      this._totalBytes += data.length;
    }

    return hash;
  }

  /**
   * Retrieve the content for a given hash.
   *
   * @param hash - The hex-encoded SHA-256 digest.
   * @returns The stored buffer, or `undefined` if no object with that hash exists.
   */
  get(hash: string): Buffer | undefined {
    return this._objects.get(hash);
  }

  /**
   * Check whether the pool contains an object with the given hash.
   *
   * @param hash - The hex-encoded SHA-256 digest.
   */
  has(hash: string): boolean {
    return this._objects.has(hash);
  }

  /**
   * Return aggregate statistics for the pool.
   */
  stats(): PoolStats {
    return {
      objectCount: this._objects.size,
      totalBytes: this._totalBytes,
    };
  }

  /**
   * Remove an object from the pool by its hash.
   *
   * @param hash - The hex-encoded SHA-256 digest to remove.
   * @returns `true` if the object existed and was removed.
   */
  delete(hash: string): boolean {
    const buf = this._objects.get(hash);
    if (buf === undefined) return false;
    this._objects.delete(hash);
    this._totalBytes -= buf.length;
    return true;
  }

  /**
   * Iterate over all hashes stored in the pool.
   */
  keys(): IterableIterator<string> {
    return this._objects.keys();
  }

  /**
   * The number of unique objects currently stored.
   */
  get size(): number {
    return this._objects.size;
  }
}

/**
 * Compute the SHA-256 hex digest of a buffer.
 */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
