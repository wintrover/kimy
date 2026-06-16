/**
 * Shared types for the partitioner module.
 */

export interface PartitionResult {
  /** Agent assignment for each task: assignment[j] = agent index */
  readonly assignment: number[];
  /** Total load per agent */
  readonly agentLoads: number[];
  /** Maximum agent load (objective 1) */
  readonly T_max: number;
  /** Which solver produced this result */
  readonly solver: 'z3' | 'greedy-fallback';
  /** Optional reason for fallback or failure */
  readonly reason?: string;
}
