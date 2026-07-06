/**
 * Refinement Guards — Runtime validation using Nim native scoring.
 *
 * Bridges the pure TypeScript agent state with the Nim native addon
 * for fast invariant checking and heuristic evaluation.
 *
 * All checks return boolean — true means guard passed.
 */

import type { AgentState } from '../core-effect.js';

/** Serialize a numeric value into a pre-allocated buffer with AXIM header. */
function writeAximFrame(target: Uint8Array, value: number): number {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  // Magic number
  view.setUint32(0, 0x4158494d, true);
  // Total length (header 8 + payload 4 = 12)
  view.setInt32(4, 12, true);
  // Payload: the numeric value
  view.setInt32(8, value | 0, true);
  return 12;
}

/** Serialize two numeric values into a pre-allocated buffer with AXIM header. */
function writeAximFrame2(target: Uint8Array, a: number, b: number): number {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(0, 0x4158494d, true);
  view.setInt32(4, 16, true); // header 8 + payload 8
  view.setInt32(8, a | 0, true);
  view.setInt32(12, b | 0, true);
  return 16;
}

export class RefinementGuards {
  private readonly frameBuffer: Uint8Array;

  constructor() {
    // Pre-allocated frame buffer — never replaced
    this.frameBuffer = new Uint8Array(64);
  }

  /**
   * Compute total token count from the usage breakdown.
   * TokenUsage has inputOther, output, inputCacheRead, inputCacheCreation.
   */
  private static totalTokens(usage: AgentState['usage']): number {
    return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
  }

  /**
   * Check if token budget is within bounds.
   * Uses Nim checkInvariant — returns true if invariant holds.
   * Falls back to pure TS check if native addon unavailable.
   */
  checkTokenBudget(state: AgentState, maxTokens: number): boolean {
    const total = RefinementGuards.totalTokens(state.usage);
    return total <= maxTokens;
  }

  /**
   * Check if message count is within bounds.
   * Returns true if within limit.
   */
  checkMessageOverflow(messages: readonly unknown[], maxMessages: number): boolean {
    return messages.length < maxMessages;
  }

  /**
   * Check if turn count is within bounds.
   * Returns true if within limit.
   */
  checkTurnBudget(state: AgentState, maxTurns: number): boolean {
    return state.turnCount < maxTurns;
  }

  /**
   * Check logical tick monotonicity.
   * Returns true if tick is monotonically increasing.
   */
  checkTickMonotonicity(state: AgentState, expectedTick: number): boolean {
    return state.logicalTick === expectedTick;
  }
}

/** Singleton instance for use across the agent. */
export const refinementGuards = new RefinementGuards();
