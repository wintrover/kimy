/**
 * Core type definitions for the Pure State Machine architecture.
 *
 * Every type in this module is plain data — no callbacks, no promises,
 * no `throw`.  The canonical step function has signature:
 *
 *   f: (AgentState, AgentInput) → (AgentState, Seq<AgentEffect>)
 *
 * Architectural principles:
 *
 *   **Principle A – Total Function** (전사 함수): no `throw`, every
 *   function accepts all valid inputs and returns a safe result.
 *
 *   **Principle B – AST-Friendly** (AST 친화적): no dynamic property
 *   access, no computed property names — every field is statically known.
 *
 *   **Principle C – Data, Not Code** (데이터, 코드가 아니다): all fields
 *   are serialisable; no functions, callbacks, or closures.
 *
 *   **Principle D – Effect Type Markers** (효과 타입 마커): every effect
 *   variant carries a `type` discriminant for exhaustive switching.
 *
 * Logical time: `logicalTick` is mandatory on every `AgentInput`. Physical
 * wall-clock time belongs only in the Shell layer, never here.
 *
 * Integer-only math: all numeric fields are integers or fixed-point
 * (scale = 400).  No floating-point ratios.
 */

import type { TokenUsage } from '@moonshot-ai/kosong';

import type { AgentPhaseState } from './phase';

export type { AgentPhaseState } from './phase';

// ---------------------------------------------------------------------------
// AgentEffect — discriminated union of all side effects the core can request
// ---------------------------------------------------------------------------

/** All possible side effects the pure core can emit. */
export type AgentEffect =
  | { readonly type: 'CALL_TOOL'; readonly toolName: string; readonly args: unknown }
  | { readonly type: 'SEND_EVENT'; readonly event: string; readonly payload: unknown }
  | { readonly type: 'LLM_REQUEST'; readonly messages: readonly unknown[]; readonly config: unknown }
  | { readonly type: 'SCHEDULE_RETRY'; readonly delayMs: number; readonly payload: unknown }
  | { readonly type: 'READ_FILE'; readonly path: string }
  | { readonly type: 'WRITE_FILE'; readonly path: string; readonly content: string }
  | { readonly type: 'EMIT_STATUS'; readonly status: string }
  | { readonly type: 'LOG_RECORD'; readonly record: unknown }
  | { readonly type: 'BEGIN_TURN'; readonly turnId: number }
  | { readonly type: 'END_TURN'; readonly turnId: number; readonly reason: string }
  | { readonly type: 'RESET_TO_PLANNING' }
  | { readonly type: 'APPEND_MESSAGE'; readonly message: unknown }
  | { readonly type: 'COMPACTION_COMPLETE'; readonly result: unknown };

// ---------------------------------------------------------------------------
// AgentState — immutable record representing the entire core state
// ---------------------------------------------------------------------------

/** Immutable core state.  All numeric fields MUST be integers or fixed-point. */
export interface AgentState {
  readonly phase: AgentPhaseState;
  readonly pendingSwarmParams: unknown;
  readonly escapeAttempted: boolean;
  /** Monotonic integer — number of completed turns. */
  readonly turnCount: number;
  /** Current token count (for compaction threshold checks). */
  readonly tokenCount: number;
  /** Message history (Message[] from kosong). */
  readonly messages: readonly unknown[];
  /** Cumulative token counters — integer counts only. */
  readonly usage: Readonly<TokenUsage>;
  /** Whether the context has been compacted. */
  readonly compacted: boolean;
  /** Monotonic integer tick — NOT wall-clock. */
  readonly logicalTick: number;
}

// ---------------------------------------------------------------------------
// AgentInput — discriminated union of all inputs the core can receive
// ---------------------------------------------------------------------------

/** All possible inputs to the pure step function.  Every variant carries logicalTick. */
export type AgentInput =
  | { readonly type: 'USER_MESSAGE'; readonly content: string; readonly logicalTick: number }
  | { readonly type: 'TOOL_RESULT'; readonly toolName: string; readonly result: unknown; readonly logicalTick: number }
  | { readonly type: 'LLM_RESPONSE'; readonly response: unknown; readonly logicalTick: number }
  | { readonly type: 'COMPACTION_TRIGGER'; readonly logicalTick: number }
  | { readonly type: 'PHASE_TRANSITION'; readonly target: AgentPhaseState; readonly logicalTick: number }
  | { readonly type: 'INIT'; readonly logicalTick: number };

// ---------------------------------------------------------------------------
// StepResult — return type of the pure step function
// ---------------------------------------------------------------------------

/** Return type of the pure step function. */
export interface StepResult {
  readonly state: AgentState;
  readonly effects: readonly AgentEffect[];
}

// ---------------------------------------------------------------------------
// PureStepFunction — the canonical function signature
// ---------------------------------------------------------------------------

/** The canonical pure step function signature: f:(State, Input) → (State, seq[AgentEffect]) */
export type PureStepFunction = (state: AgentState, input: AgentInput) => StepResult;

// ---------------------------------------------------------------------------
// createInitialAgentState — factory for the zero state
// ---------------------------------------------------------------------------

/** Create the initial AgentState with logicalTick = 0. */
export function createInitialAgentState(): AgentState {
  return {
    phase: 'planning' as AgentPhaseState,
    pendingSwarmParams: null,
    escapeAttempted: false,
    turnCount: 0,
    tokenCount: 0,
    messages: [],
    usage: {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    compacted: false,
    logicalTick: 0,
  };
}
