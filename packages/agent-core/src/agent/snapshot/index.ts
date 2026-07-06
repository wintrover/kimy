export {
  computeSnapshotHash,
  createSnapshot,
  serializeAgentState,
} from '#/agent/snapshot/serialize';

export {
  deserializeAgentState,
  verifySnapshotHash,
} from '#/agent/snapshot/deserialize';

export {
  computeEpoch,
  shouldCreateSnapshot,
} from '#/agent/snapshot/epoch';

export {
  SnapshotPersistence,
} from '#/agent/snapshot/persistence';

export {
  CURRENT_SCHEMA_VERSION,
  EPOCH_SIZE,
  KEEP_LAST_EPOCHS,
  type AgentSnapshot,
  type SerializedAgentState,
  type SnapshotHeader,
} from '#/agent/snapshot/types';

export {
  AutoSnapshotManager,
} from '#/agent/snapshot/auto-snapshot';

export {
  ReplayGateway,
} from '#/agent/snapshot/replay-gateway';

export type {
  ReplayOptions,
  ReplayResult,
} from '#/agent/snapshot/replay-gateway';
