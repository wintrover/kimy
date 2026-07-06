/**
 * Pure step function extracted from TurnFlow.
 *
 * Models the turn execution loop as a state machine: given a current
 * {@link AgentState} and an {@link AgentInput}, it produces a new immutable
 * state and a list of side-effect descriptors — never throws, never mutates.
 *
 * Architectural principles (mirrored from turn-pure.ts):
 *   A. Total Function Enforcement — no `throw`; every branch returns.
 *   B. AST-Friendly Syntax — only static switch/case on `input.type`.
 *   C. Data, Not Code — return serializable PODs, never callbacks/promises.
 *   D. Effect Type Markers — every side effect is an `AgentEffect` variant.
 */

import type {
  AgentState,
  AgentEffect,
  AgentInput,
  StepResult,
} from '#/agent/core-effect';

// Re-export canonical types for downstream consumers.
export type { AgentPhaseState, AgentState, AgentEffect, AgentInput, StepResult } from '#/agent/core-effect';

// ---------------------------------------------------------------------------
// Tick validation (Principle A — total)
// ---------------------------------------------------------------------------

/**
 * Validates that the input's logicalTick is exactly one ahead of the state's.
 * Returns `null` when valid, or an error message string when invalid.
 */
export function validateTick(state: AgentState, input: AgentInput): string | null {
  const expected = state.logicalTick + 1;
  if (input.logicalTick === expected) return null;
  return `Logical tick mismatch: expected ${expected}, got ${input.logicalTick}`;
}

// ---------------------------------------------------------------------------
// Input classification (Principle B — static switch only)
// ---------------------------------------------------------------------------

/**
 * Classifies the kind of input received. Returns a deterministic string tag
 * suitable for telemetry / logging.
 */
export function classifyTurnInput(input: AgentInput): string {
  switch (input.type) {
    case 'INIT':              return 'init';
    case 'USER_MESSAGE':      return 'user_message';
    case 'TOOL_RESULT':       return 'tool_result';
    case 'LLM_RESPONSE':      return 'llm_response';
    case 'COMPACTION_TRIGGER': return 'compaction_trigger';
    case 'PHASE_TRANSITION':   return 'phase_transition';
    // Principle A: total — every branch must have a return
    default: {
      // Exhaustiveness guard — never reached with well-typed input
      const _exhaustive: never = input;
      return 'unknown';
    }
  }
}

// ---------------------------------------------------------------------------
// Effect builder (Principle D — every effect is an AgentEffect variant)
// ---------------------------------------------------------------------------

/**
 * Determines what side effects should fire based on the current state and
 * incoming input. All returned values are plain data descriptors — no
 * callbacks, no promises, no mutation.
 */
export function buildTurnEffects(state: AgentState, input: AgentInput): readonly AgentEffect[] {
  switch (input.type) {
    case 'INIT': {
      const effects: AgentEffect[] = [
        { type: 'LOG_RECORD', record: { type: 'turn.init', logicalTick: input.logicalTick } },
      ];
      return effects;
    }

    case 'USER_MESSAGE': {
      const effects: AgentEffect[] = [
        { type: 'APPEND_MESSAGE', message: { content: input.content } },
        { type: 'EMIT_STATUS', status: 'turn_started' },
        { type: 'LOG_RECORD', record: { type: 'turn.prompt', content: input.content } },
      ];
      // Request LLM when in planning phase
      if (state.phase === 'planning') {
        effects.push({
          type: 'LLM_REQUEST',
          messages: [...state.messages],
          config: {},
        });
      }
      return effects;
    }

    case 'TOOL_RESULT': {
      const effects: AgentEffect[] = [
        { type: 'LOG_RECORD', record: { type: 'tool.result', toolName: input.toolName } },
      ];
      // Request LLM for next step in execution phase
      if (state.phase === 'execution') {
        effects.push({
          type: 'LLM_REQUEST',
          messages: [...state.messages],
          config: {},
        });
      }
      return effects;
    }

    case 'LLM_RESPONSE': {
      const effects: AgentEffect[] = [
        { type: 'EMIT_STATUS', status: 'turn_completed' },
        { type: 'LOG_RECORD', record: { type: 'turn.response' } },
      ];
      return effects;
    }

    case 'COMPACTION_TRIGGER': {
      const effects: AgentEffect[] = [
        { type: 'LOG_RECORD', record: { type: 'compaction.trigger', logicalTick: input.logicalTick } },
      ];
      return effects;
    }

    case 'PHASE_TRANSITION': {
      const effects: AgentEffect[] = [
        { type: 'LOG_RECORD', record: { type: 'phase.transition', target: input.target } },
      ];
      if (input.target === 'planning') {
        effects.push({ type: 'RESET_TO_PLANNING' });
      }
      return effects;
    }

    // Principle A: total — every exhaustive union branch must have a default
    default: {
      const _exhaustive: never = input;
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// State advancement (Principle C — immutable data)
// ---------------------------------------------------------------------------

/**
 * Computes the next immutable {@link AgentState} from the current state and
 * the effects that were produced. Never mutates the input state.
 *
 * @nim-hook Future integration point for Nim `evaluateHeuristic`:
 *   The Nim native addon can evaluate heuristic scores over the resulting
 *   state to determine quality of the transition. The AXIM protocol would
 *   serialize the (state, effects) pair and receive a float score in return.
 */
export function advanceState(state: AgentState, effects: readonly AgentEffect[]): AgentState {
  let nextPhase = state.phase;
  let nextTurnCount = state.turnCount;
  let nextCompacted = state.compacted;
  let nextEscapeAttempted = state.escapeAttempted;

  for (const effect of effects) {
    switch (effect.type) {
      case 'BEGIN_TURN':
        nextTurnCount = state.turnCount + 1;
        break;
      case 'END_TURN':
        // Turn ending — stay in current phase
        break;
      case 'RESET_TO_PLANNING':
        nextPhase = 'planning';
        nextEscapeAttempted = false;
        break;
      // Other effects don't change state
      case 'CALL_TOOL':
      case 'SEND_EVENT':
      case 'LLM_REQUEST':
      case 'SCHEDULE_RETRY':
      case 'READ_FILE':
      case 'WRITE_FILE':
      case 'EMIT_STATUS':
      case 'LOG_RECORD':
      case 'APPEND_MESSAGE':
      case 'COMPACTION_COMPLETE':
        break;
      // Principle A: total
      default: {
        const _exhaustive: never = effect;
        break;
      }
    }
  }

  return {
    phase: nextPhase,
    pendingSwarmParams: state.pendingSwarmParams,
    escapeAttempted: nextEscapeAttempted,
    turnCount: nextTurnCount,
    tokenCount: state.tokenCount,
    messages: state.messages,
    usage: state.usage,
    compacted: nextCompacted,
    logicalTick: state.logicalTick + 1,
  };
}

// ---------------------------------------------------------------------------
// Main step function (Principle A + B + C + D)
// ---------------------------------------------------------------------------

/**
 * The core pure step function for the turn execution loop.
 *
 * Given a current {@link AgentState} and an {@link AgentInput}, validates the
 * logical tick, builds the required effects, and advances the state — all
 * without throwing or mutating anything.
 *
 * @nim-hook Future integration point for Nim `scoreMove`:
 *   After building effects and before returning, the Nim addon could score
 *   the candidate move (effect sequence) to guide search-based refinement.
 *   The AXIM protocol would send the (state, input, effects) tuple and
 *   receive a priority score for refinement ordering.
 */
export function turnStep(state: AgentState, input: AgentInput): StepResult {
  // 1. Validate tick ordering
  const tickError = validateTick(state, input);
  if (tickError !== null) {
    return {
      state: advanceState(state, []),
      effects: [
        { type: 'SEND_EVENT', event: 'error', payload: { message: tickError } },
        { type: 'LOG_RECORD', record: { type: 'tick.error', message: tickError } },
      ],
    };
  }

  // 2. Build effects based on input type
  const effects = buildTurnEffects(state, input);

  // 3. Advance state
  const nextState = advanceState(state, effects);

  return { state: nextState, effects };
}

// ---------------------------------------------------------------------------
// Helpers for constructing initial state
// ---------------------------------------------------------------------------

/**
 * Creates a fresh {@link AgentState} at logical tick 0.
 */
export function createInitialState(overrides?: Partial<AgentState>): AgentState {
  return {
    phase: 'planning',
    pendingSwarmParams: null,
    escapeAttempted: false,
    turnCount: 0,
    tokenCount: 0,
    messages: [],
    usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    compacted: false,
    logicalTick: 0,
    ...overrides,
  };
}
