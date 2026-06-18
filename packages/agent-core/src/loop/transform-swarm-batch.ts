/**
 * Detects when an LLM response contains AgentSwarm mixed with other tool calls
 * and reorders the batch so AgentSwarm runs last. AgentSwarm must execute in
 * isolation — interleaving it with other tools leads to unpredictable scheduling.
 *
 * The input array is **mutated in place** to stay consistent with how the loop
 * layer handles tool-call arrays.
 */

import type { PreflightedToolCall } from './tool-call';

/** Result of the swarm-batch transform. */
export interface SwarmBatchTransformResult {
  /** Whether the batch was reordered. */
  readonly reordered: boolean;
  /** A system reminder to inject into the next message when reordering occurred. */
  readonly systemReminder: string | undefined;
}

/**
 * System reminder injected into the next model message when the batch was
 * reordered. Tells the model not to combine AgentSwarm with other tools.
 */
export const SWARM_BATCH_REORDER_REMINDER: string =
  'This batch contained AgentSwarm alongside other tools. AgentSwarm must run alone, so the system automatically reordered the batch: other tools ran first and AgentSwarm was placed last. In future responses, call AgentSwarm by itself — do not combine it with other tools.';

/**
 * When exactly one AgentSwarm call appears alongside other tool calls in the
 * same batch, move it to the end so it executes last. The array is mutated in
 * place.
 *
 * @returns Information about whether reordering happened and what reminder to
 *   inject.
 */
export function transformSwarmBatch(calls: PreflightedToolCall[]): SwarmBatchTransformResult {
  let swarmCount = 0;
  let swarmIndex = -1;

  for (let i = 0; i < calls.length; i += 1) {
    if (calls[i]!.toolName === 'AgentSwarm') {
      swarmCount += 1;
      swarmIndex = i;
    }
  }

  if (swarmCount !== 1 || calls.length <= 1) {
    return { reordered: false, systemReminder: undefined };
  }

  const [swarmCall] = calls.splice(swarmIndex, 1) as [PreflightedToolCall];
  calls.push(swarmCall);

  return { reordered: true, systemReminder: SWARM_BATCH_REORDER_REMINDER };
}
