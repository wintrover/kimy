import type { AgentState } from '#/agent/core-effect';

import type { AgentSnapshot, SerializedAgentState } from '#/agent/snapshot/types';

import { computeSnapshotHash } from '#/agent/snapshot/serialize';

/** Reconstruct an AgentState from its serialized form. */
export function deserializeAgentState(serialized: SerializedAgentState): AgentState {
  return {
    phase: serialized.phase,
    turnCount: serialized.turnCount,
    tokenCount: serialized.tokenCount,
    logicalTick: serialized.logicalTick,
    compacted: serialized.compacted,
    escapeAttempted: serialized.escapeAttempted,
    pendingSwarmParams: serialized.pendingSwarmParams,
    usage: { ...serialized.usage },
    messages: [...serialized.messages],
  };
}

/** Recompute hash and compare against the stored header hash. */
export function verifySnapshotHash(snapshot: AgentSnapshot): boolean {
  const recomputed = computeSnapshotHash(snapshot.state);
  return recomputed === snapshot.header.sha256;
}
