import { createHash } from 'node:crypto';

import type { AgentState } from '#/agent/core-effect';

import { computeEpoch } from '#/agent/snapshot/epoch';
import {
  CURRENT_SCHEMA_VERSION,
  type AgentSnapshot,
  type SerializedAgentState,
} from '#/agent/snapshot/types';

/** Extract serializable fields from an AgentState. */
export function serializeAgentState(state: AgentState): SerializedAgentState {
  return {
    phase: state.phase,
    turnCount: state.turnCount,
    tokenCount: state.tokenCount,
    logicalTick: state.logicalTick,
    compacted: state.compacted,
    escapeAttempted: state.escapeAttempted,
    pendingSwarmParams: state.pendingSwarmParams,
    usage: { ...state.usage },
    messages: [...state.messages],
  };
}

/** Compute SHA-256 hex digest of the JSON-serialized state. */
export function computeSnapshotHash(state: SerializedAgentState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

/** Create a full snapshot with header from the current AgentState. */
export function createSnapshot(
  state: AgentState,
  wireRecordCount: number,
): AgentSnapshot {
  const serialized = serializeAgentState(state);
  const sha256 = computeSnapshotHash(serialized);

  return {
    header: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      epoch: computeEpoch(state.turnCount),
      logicalTick: state.logicalTick,
      sha256,
      wireRecordCount,
      createdAt: Date.now(),
    },
    state: serialized,
  };
}
