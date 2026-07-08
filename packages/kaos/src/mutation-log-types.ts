/**
 * Lightweight MutationLog contract for the kaos package.
 *
 * This mirrors the types from agent-core's mutation-log without creating
 * a direct dependency — agent-core is the source of truth; this file is
 * a structural duplicate kept intentionally narrow.
 */

/**
 * A single file mutation produced by an agent.
 */
export interface MutationOp {
  /** Nature of the mutation. */
  readonly type: 'write' | 'delete';
  /** UTF-8 file path (forward-slash separated). */
  readonly path: string;
  /** File content (present for `write` ops). */
  readonly content?: string;
  /** Deterministic ordering key — assigned at agent spawn time. */
  readonly staticSequenceId: number;
  /** Identifier of the agent that produced this mutation. */
  readonly agentId: string;
}

/**
 * Minimal interface for recording mutation operations.
 */
export interface MutationRecorder {
  record(op: MutationOp): void;
}
