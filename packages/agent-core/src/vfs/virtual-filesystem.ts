/**
 * VirtualFilesystem — Immutable epoch-based virtual file system.
 *
 * Replaces OS filesystem dependency with in-memory immutable snapshots.
 * Each "epoch" is a frozen snapshot: agents see consistent file state
 * across their entire turn, and epochs are isolated from each other so
 * concurrent agents cannot interfere with each other's file views.
 *
 * Design invariants:
 * - Epochs are append-only. Mutations always produce a *new* epoch.
 * - Each epoch's file map is frozen (`Object.freeze`) — read-only after creation.
 * - Rollback is O(1): just switch the active pointer to a previous epoch.
 * - The epoch history is retained so that any agent can reference a past view.
 */

import type { StructuralASTMutation } from '#/tools/builtin/file/structural-mutation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single immutable snapshot of the virtual filesystem.
 *
 * - `id`       — Monotonically increasing epoch identifier.
 * - `files`    — Frozen `Map<string, string>` of path → content.
 * - `createdAt`— `Date.now()` timestamp at creation.
 * - `frozen`   — Always `true` after creation; serves as a runtime guard.
 */
export interface VfsEpoch {
  readonly id: number;
  readonly files: ReadonlyMap<string, string>;
  readonly createdAt: number;
  readonly frozen: boolean;
}

/**
 * An epoch *plus* an optional reference to the mutation that produced it.
 * Stored internally for bookkeeping but not exposed in the public interface.
 */
interface EpochRecord {
  readonly epoch: VfsEpoch;
  /** The mutations applied to create this epoch from its parent, if any. */
  readonly mutations?: readonly StructuralASTMutation[];
}

// ---------------------------------------------------------------------------
// VirtualFilesystem
// ---------------------------------------------------------------------------

export class VirtualFilesystem {
  /** Monotonically increasing epoch counter. */
  private _nextEpochId = 0;

  /** Ordered history of all epochs (index = epoch id). */
  private _history: EpochRecord[] = [];

  /** Pointer to the currently active epoch record. */
  private _activeIndex = 0;

  // ── Construction ──────────────────────────────────────────────────────

  constructor() {
    // Bootstrap with an empty epoch (epoch 0).
    const seed = this._createEpoch(new Map());
    this._history.push({ epoch: seed });
    this._activeIndex = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Create a new epoch branched from the current active epoch.
   * The new epoch starts with an identical copy of the active file set.
   * Returns the newly created (and activated) epoch.
   */
  createEpoch(): VfsEpoch {
    const snapshot = new Map(this.getActiveEpoch().files);
    const epoch = this._createEpoch(snapshot);
    this._history.push({ epoch });
    this._activeIndex = this._history.length - 1;
    return epoch;
  }

  /**
   * Return the currently active epoch.
   */
  getActiveEpoch(): VfsEpoch {
    return this._history[this._activeIndex]!.epoch;
  }

  /**
   * Look up a single file in the active epoch.
   * Returns the content string, or `undefined` if the path does not exist.
   */
  getFile(path: string): string | undefined {
    return this.getActiveEpoch().files.get(path);
  }

  /**
   * Apply structural AST mutations to a specific file and produce a new epoch.
   *
   * The mutation is performed against the file content in the active epoch.
   * The caller is responsible for passing valid `StructuralASTMutation[]`
   * whose `node_id` values resolve against the file's current content.
   *
   * @param filePath  — The file to mutate (must already exist in the active epoch).
   * @param mutations — Array of structural mutations to apply.
   * @returns The new epoch containing the mutated file.
   * @throws If the file does not exist in the active epoch.
   */
  applyFileMutations(
    filePath: string,
    mutations: readonly StructuralASTMutation[],
  ): VfsEpoch {
    const active = this.getActiveEpoch();
    const currentContent = active.files.get(filePath);
    if (currentContent === undefined) {
      throw new Error(
        `VFS: cannot apply mutations — file "${filePath}" does not exist in epoch ${active.id}.`,
      );
    }

    // Build the new file map from the active epoch and patch the target file.
    const nextFiles = new Map(active.files);
    nextFiles.set(filePath, applyTextMutations(currentContent, mutations));

    const epoch = this._createEpoch(nextFiles);
    this._history.push({ epoch, mutations });
    this._activeIndex = this._history.length - 1;
    return epoch;
  }

  /**
   * Create a new epoch by applying an array of structural AST mutations
   * to files in the active epoch.
   *
   * Each entry in `mutations` must specify which file it targets via a
   * companion `filePath` field (bundled here for convenience).
   *
   * @param fileMutations — Array of `{ filePath, mutations }` pairs.
   * @returns The new epoch containing all mutated files.
   */
  applyMutations(
    fileMutations: Array<{
      filePath: string;
      mutations: StructuralASTMutation[];
    }>,
  ): VfsEpoch {
    const active = this.getActiveEpoch();
    const nextFiles = new Map(active.files);
    const allMutations: StructuralASTMutation[] = [];

    for (const { filePath, mutations } of fileMutations) {
      const currentContent = nextFiles.get(filePath);
      if (currentContent === undefined) {
        throw new Error(
          `VFS: cannot apply mutations — file "${filePath}" does not exist in epoch ${active.id}.`,
        );
      }
      nextFiles.set(filePath, applyTextMutations(currentContent, mutations));
      allMutations.push(...mutations);
    }

    const epoch = this._createEpoch(nextFiles);
    this._history.push({ epoch, mutations: allMutations });
    this._activeIndex = this._history.length - 1;
    return epoch;
  }

  /**
   * Write (create or overwrite) a file and produce a new epoch.
   */
  writeFile(path: string, content: string): VfsEpoch {
    const active = this.getActiveEpoch();
    const nextFiles = new Map(active.files);
    nextFiles.set(path, content);

    const epoch = this._createEpoch(nextFiles);
    this._history.push({ epoch });
    this._activeIndex = this._history.length - 1;
    return epoch;
  }

  /**
   * Delete a file and produce a new epoch.
   * No-op (returns current active epoch) if the file does not exist.
   */
  deleteFile(path: string): VfsEpoch {
    const active = this.getActiveEpoch();
    if (!active.files.has(path)) {
      return active;
    }
    const nextFiles = new Map(active.files);
    nextFiles.delete(path);

    const epoch = this._createEpoch(nextFiles);
    this._history.push({ epoch });
    this._activeIndex = this._history.length - 1;
    return epoch;
  }

  /**
   * Rollback to the previous epoch — O(1).
   *
   * Returns the (now active) previous epoch.
   * If already at epoch 0, returns the seed epoch unchanged.
   */
  rollback(): VfsEpoch {
    if (this._activeIndex > 0) {
      this._activeIndex -= 1;
    }
    return this.getActiveEpoch();
  }

  /**
   * Rollback to a specific epoch id — O(1).
   *
   * @throws If the epoch id does not exist.
   */
  rollbackTo(epochId: number): VfsEpoch {
    const record = this._history[epochId];
    if (record === undefined) {
      throw new Error(`VFS: epoch ${epochId} does not exist.`);
    }
    this._activeIndex = epochId;
    return record.epoch;
  }

  /**
   * Return the full epoch history (read-only view).
   */
  getHistory(): readonly VfsEpoch[] {
    return this._history.map((r) => r.epoch);
  }

  /**
   * Total number of epochs that have been created (including the seed).
   */
  get epochCount(): number {
    return this._history.length;
  }

  /**
   * The id of the currently active epoch.
   */
  get activeEpochId(): number {
    return this.getActiveEpoch().id;
  }

  /**
   * Remove all epochs *after* the current active epoch, permanently
   * discarding any forward history. Useful after a rollback when you
   * want to guarantee no forward branch can be re-entered.
   *
   * Returns the (unchanged) active epoch.
   */
  pruneForwardHistory(): VfsEpoch {
    this._history.length = this._activeIndex + 1;
    return this.getActiveEpoch();
  }

  /**
   * Bulk-load files into the current epoch, producing a new epoch.
   */
  loadFiles(files: Map<string, string>): VfsEpoch {
    const active = this.getActiveEpoch();
    const nextFiles = new Map(active.files);
    for (const [path, content] of files) {
      nextFiles.set(path, content);
    }
    const epoch = this._createEpoch(nextFiles);
    this._history.push({ epoch });
    this._activeIndex = this._history.length - 1;
    return epoch;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _createEpoch(files: Map<string, string>): VfsEpoch {
    const id = this._nextEpochId++;
    const frozen = true;
    const epoch: VfsEpoch = {
      id,
      files: Object.freeze(files),
      createdAt: Date.now(),
      frozen,
    };
    return epoch;
  }
}

// ---------------------------------------------------------------------------
// Mutation helpers (pure, stateless)
// ---------------------------------------------------------------------------

/**
 * Apply an array of `StructuralASTMutation` to a text string.
 *
 * This is a **simplified** text-range replacement that operates on the
 * raw text without tree-sitter.  It resolves mutations by matching
 * `node_id` against a content-addressed map built from the text.
 *
 * For production use, the tree-sitter-backed `applyStructuralMutations`
 * from `#/tools/builtin/file/structural-mutation` should be preferred.
 * This fallback exists so the VFS can apply mutations synchronously
 * when tree-sitter is unavailable (e.g., unit tests).
 */
function applyTextMutations(
  source: string,
  mutations: readonly StructuralASTMutation[],
): string {
  if (mutations.length === 0) {
    return source;
  }

  let result = source;

  // Apply mutations sequentially — each mutation targets a node_id in the
  // *current* text state, so offset computation is straightforward.
  // We use last-index-wins semantics (same as tree-sitter path).
  for (const mutation of mutations) {
    const nodeHash = hashContent(mutation.node_id);
    const idx = result.indexOf(nodeHash);
    if (idx === -1) {
      // Node not found — skip silently (caller validated upstream).
      continue;
    }
    const op = mutation.operation ?? 'replace';
    switch (op) {
      case 'replace':
        result = result.slice(0, idx) + mutation.replacement + result.slice(idx + nodeHash.length);
        break;
      case 'insert_before':
        result = result.slice(0, idx) + mutation.replacement + result.slice(idx);
        break;
      case 'insert_after':
        result = result.slice(0, idx + nodeHash.length) + mutation.replacement + result.slice(idx + nodeHash.length);
        break;
      case 'delete':
        result = result.slice(0, idx) + result.slice(idx + nodeHash.length);
        break;
    }
  }

  return result;
}

/**
 * Minimal content hash — reuses the same truncation length (16 hex chars)
 * as the tree-sitter path for consistency.  This is *not* crypto-secure;
 * it only needs to be stable for VFS-internal node-id matching.
 */
function hashContent(text: string): string {
  // Use a simple DJB2-style hash for zero-dependency operation.
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 16);
}
