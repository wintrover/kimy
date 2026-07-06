import type { AgentState } from '#/agent/core-effect';
import { shouldCreateSnapshot } from '#/agent/snapshot/epoch';
import { createSnapshot } from '#/agent/snapshot/serialize';
import { SnapshotPersistence } from '#/agent/snapshot/persistence';
import { KEEP_LAST_EPOCHS } from '#/agent/snapshot/types';

/**
 * Manages automatic snapshot creation at epoch boundaries.
 * Snapshots are created asynchronously in the background to avoid
 * blocking the main event loop.
 */
export class AutoSnapshotManager {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: SnapshotPersistence,
    private readonly keepLast: number = KEEP_LAST_EPOCHS,
  ) {}

  /**
   * Called after each turn completes. If the turn count hits an epoch
   * boundary, enqueues a snapshot creation task.
   */
  onTurnComplete(
    turnCount: number,
    state: AgentState,
    wireRecordCount: number,
  ): void {
    if (!shouldCreateSnapshot(turnCount)) return;
    // Chain onto pending to serialize snapshot writes
    this.pending = this.pending
      .then(() => this.createAndPrune(state, wireRecordCount))
      .catch((err) => {
        // Snapshot failures must never crash the agent loop
        console.error('[AutoSnapshot] Failed to create snapshot:', err);
      });
  }

  /**
   * Wait for any pending snapshot operations to complete.
   * Called during graceful shutdown.
   */
  async drain(): Promise<void> {
    await this.pending;
  }

  private async createAndPrune(
    state: AgentState,
    wireRecordCount: number,
  ): Promise<void> {
    const snapshot = createSnapshot(state, wireRecordCount);
    await this.persistence.save(snapshot);
    await this.persistence.prune(this.keepLast);
  }
}
