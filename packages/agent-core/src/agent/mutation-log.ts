/**
 * MutationLog + DeterministicReducer — deterministic linearization of
 * cross-agent mutations.
 *
 * When multiple agents produce file mutations concurrently, the
 * `MutationLog` records every operation and provides a deterministic
 * sort order (static-sequence-id ASC → byte-ordered path ASC).  The
 * `DeterministicReducer` applies those linearised operations to a
 * {@link MerkleFileIndex} and resolves conflicts using a two-tier
 * policy:
 *
 * 1. **Delete dominates** — a delete always beats a write, regardless
 *    of sequence id.
 * 2. **SLWW** (Static-sequence-id Later-Writer-Wins) — among writes,
 *    the operation with the highest `staticSequenceId` wins.
 *
 * `staticSequenceId` is assigned at **spawn time**, not completion
 * time, so the ordering is deterministic even when agents finish out of
 * order.
 */
import { createHash } from 'node:crypto';
import type { MerkleFileIndex, FileEntry, ContentAddressedPool } from '@moonshot-ai/kaos';

// ── Public types ────────────────────────────────────────────────────

/**
 * A single file mutation produced by an agent.
 */
export interface MutationOp {
  /** Nature of the mutation. */
  type: 'write' | 'delete';
  /** UTF-8 file path (forward-slash separated). */
  path: string;
  /** File content (present for `write` ops). */
  content?: string;
  /** Deterministic ordering key — assigned at agent spawn time. */
  staticSequenceId: number;
  /** Identifier of the agent that produced this mutation. */
  agentId: string;
}

/**
 * Two or more mutations targeting the same file path.
 */
export interface FileConflict {
  /** The conflicting file path. */
  path: string;
  /** All operations targeting this path. */
  ops: MutationOp[];
}

/**
 * Conflict resolution strategy.
 */
export enum ConflictResolution {
  /** A delete always beats a write. */
  DELETE_DOMINATES = 'delete',
  /** Static-sequence-id Later-Writer-Wins. */
  SLWW = 'slww',
}

// ── MutationLog ────────────────────────────────────────────────────

/**
 * Records mutation operations and provides deterministic linearisation.
 *
 * The sort order is:
 * 1. `staticSequenceId` ascending (lower id = earlier agent = lower priority).
 * 2. `Buffer.compare(path)` ascending (pure byte sort, never `localeCompare`).
 *
 * @example
 * ```ts
 * const log = new MutationLog();
 * log.record({ type: 'write', path: 'b.ts', content: '...', staticSequenceId: 2, agentId: 'a1' });
 * log.record({ type: 'write', path: 'a.ts', content: '...', staticSequenceId: 1, agentId: 'a2' });
 * const sorted = log.linearize();
 * // sorted[0].path === 'a.ts' (id 1 < 2)
 * // sorted[1].path === 'b.ts'
 * ```
 */
export class MutationLog {
  private _ops: MutationOp[] = [];

  /**
   * Record a mutation operation.
   */
  record(op: MutationOp): void {
    this._ops.push(op);
  }

  /**
   * Return all recorded operations.
   */
  get operations(): readonly MutationOp[] {
    return this._ops;
  }

  /**
   * Return the number of recorded operations.
   */
  get size(): number {
    return this._ops.length;
  }

  /**
   * Linearise the recorded operations into a deterministic order.
   *
   * Sort key:
   * 1. `staticSequenceId` ascending.
   * 2. `Buffer.compare(path)` ascending — pure byte sort.
   *
   * @returns A new sorted array (the original log is not mutated).
   */
  linearize(): MutationOp[] {
    return [...this._ops].sort((a, b) => {
      if (a.staticSequenceId !== b.staticSequenceId) {
        return a.staticSequenceId - b.staticSequenceId;
      }
      return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    });
  }

  /**
   * Detect file-level conflicts — paths with more than one operation.
   *
   * @returns An array of {@link FileConflict}, one per conflicting path.
   */
  detectConflicts(): FileConflict[] {
    const byPath = new Map<string, MutationOp[]>();
    for (const op of this._ops) {
      const existing = byPath.get(op.path) ?? [];
      existing.push(op);
      byPath.set(op.path, existing);
    }
    const conflicts: FileConflict[] = [];
    for (const [p, ops] of byPath) {
      if (ops.length > 1) {
        conflicts.push({ path: p, ops });
      }
    }
    return conflicts;
  }

  /**
   * Clear all recorded operations.
   */
  clear(): void {
    this._ops.length = 0;
  }
}

// ── DeterministicReducer ───────────────────────────────────────────

/**
 * Applies linearised mutations to a {@link MerkleFileIndex} and
 * resolves conflicts.
 *
 * The reducer:
 * 1. Linearises all operations using {@link MutationLog.linearize}.
 * 2. Applies them sequentially to a branch of `baseIndex`.
 * 3. Returns the mutated index.
 *
 * Conflict resolution follows the two-tier policy:
 * 1. Delete dominates.
 * 2. SLWW (highest `staticSequenceId` wins among writes).
 */
export class DeterministicReducer {
  /**
   * Apply linearised operations to `baseIndex`.
   *
   * Operations are applied in deterministic order.  The index is
   * mutated in place; callers who need immutability should branch it
   * first.
   *
   * @param ops        - Operations to apply (should be pre-linearised
   *   or will be linearised internally).
   * @param baseIndex  - The MerkleFileIndex to mutate.
   * @param pool       - Content-addressed pool (reserved for future use
   *   when content is stored externally).
   * @returns The same `baseIndex` reference, now mutated.
   */
  reduce(
    ops: MutationOp[],
    baseIndex: MerkleFileIndex,
    _pool: ContentAddressedPool,
  ): MerkleFileIndex {
    // Linearise the operations.
    const log = new MutationLog();
    for (const op of ops) {
      log.record(op);
    }
    const sorted = log.linearize();

    // Apply sequentially.
    for (const op of sorted) {
      if (op.type === 'write' && op.content !== undefined) {
        baseIndex.writeFile(op.path, op.content);
      } else if (op.type === 'delete') {
        baseIndex.deleteFile(op.path);
      }
    }

    return baseIndex;
  }

  /**
   * Resolve file-level conflicts using the two-tier policy.
   *
   * For each conflict:
   * 1. If any operation is a delete, the **last** delete (highest
   *    `staticSequenceId`) wins.
   * 2. Otherwise, SLWW — the write with the highest
   *    `staticSequenceId` wins.
   *
   * @param conflicts - Conflicts from {@link MutationLog.detectConflicts}.
   * @returns One winning {@link MutationOp} per conflict.
   */
  resolveConflicts(conflicts: FileConflict[]): MutationOp[] {
    return conflicts.map((conflict) => {
      const deletes = conflict.ops.filter((o) => o.type === 'delete');
      if (deletes.length > 0) {
        // Delete dominates — pick the highest staticSequenceId delete.
        return deletes.reduce((a, b) =>
          a.staticSequenceId >= b.staticSequenceId ? a : b,
        );
      }
      // SLWW — highest staticSequenceId wins among writes.
      return conflict.ops.reduce((a, b) =>
        a.staticSequenceId >= b.staticSequenceId ? a : b,
      );
    });
  }
}
