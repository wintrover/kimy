import type { TokenUsage } from '@moonshot-ai/kosong';

import type { AgentPhaseState } from '#/agent/core-effect';

export const CURRENT_SCHEMA_VERSION = 1;
export const EPOCH_SIZE = 100;
export const KEEP_LAST_EPOCHS = 3;

export interface SnapshotHeader {
  readonly schemaVersion: number;
  readonly epoch: number;
  readonly logicalTick: number;
  readonly sha256: string; // 64 hex chars
  readonly wireRecordCount: number;
  readonly createdAt: number;
}

export interface SerializedAgentState {
  readonly phase: AgentPhaseState;
  readonly turnCount: number;
  readonly tokenCount: number;
  readonly logicalTick: number;
  readonly compacted: boolean;
  readonly escapeAttempted: boolean;
  readonly pendingSwarmParams: unknown;
  readonly usage: TokenUsage;
  readonly messages: readonly unknown[];
}

export interface AgentSnapshot {
  readonly header: SnapshotHeader;
  readonly state: SerializedAgentState;
}
