import type { AgentRecords } from '#/agent/records/index';
import type { NapiAgentCore } from '#/nim/bindings';
import { SnapshotPersistence } from '#/agent/snapshot/persistence';
import { verifySnapshotHash } from '#/agent/snapshot/deserialize';
import { CURRENT_SCHEMA_VERSION } from '#/agent/snapshot/types';
import type { AgentSnapshot } from '#/agent/snapshot/types';

export interface ReplayOptions {
  range?: { start?: number; count?: number };
}

export interface ReplayResult {
  warning?: string;
  usedSnapshot: boolean;
  snapshotEpoch?: number;
  deltaCount: number;
}

export class ReplayGateway {
  constructor(
    private readonly records: AgentRecords,
    private readonly persistence: SnapshotPersistence,
    private readonly nim?: NapiAgentCore | null,
  ) {}

  async replay(_options?: ReplayOptions): Promise<ReplayResult> {
    // 1. Try to load latest snapshot
    const snapshot = await this.persistence.loadLatest();

    if (!snapshot) {
      // No snapshot — fallback to full replay
      const warning = await this.records.replay();
      return { warning: warning?.warning, usedSnapshot: false, deltaCount: 0 };
    }

    // 2. Verify hash integrity
    if (!verifySnapshotHash(snapshot)) {
      // Hash mismatch — fallback to full replay
      const warning = await this.records.replay();
      return { warning: warning?.warning, usedSnapshot: false, deltaCount: 0 };
    }

    // 3. Schema migration if needed
    let activeSnapshot = snapshot;
    if (snapshot.header.schemaVersion < CURRENT_SCHEMA_VERSION) {
      // Try Nim migration
      if (this.nim) {
        const migrated = this.tryMigrate(snapshot);
        if (migrated) {
          activeSnapshot = migrated;
        } else {
          // Migration failed — fallback
          const warning = await this.records.replay();
          return { warning: warning?.warning, usedSnapshot: false, deltaCount: 0 };
        }
      }
    }

    // 4. Replay with snapshot (for now, still falls through to full replay
    //    until Nim applyEvents is fully wired with delta filtering)
    const warning = await this.records.replay();

    return {
      warning: warning?.warning,
      usedSnapshot: true,
      snapshotEpoch: activeSnapshot.header.epoch,
      deltaCount: 0, // TODO: count actual deltas after snapshot epoch
    };
  }

  private tryMigrate(_snapshot: AgentSnapshot): AgentSnapshot | null {
    // Attempt Nim-based migration
    // For now, return null (migration not yet needed for v1)
    return null;
  }
}
