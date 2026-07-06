/**
 * Pure compaction step functions extracted from FullCompaction.
 *
 * These are stateless transforms over plain data — no side effects, no class
 * dependencies.  Every side effect is represented as an AgentEffect value
 * returned in the StepResult.effects array.
 *
 * Architectural principles:
 *   A. No `throw` — return error effects.
 *   B. Static branching only (if/else, switch/case).
 *   C. Data only — return serializable PODs.
 *   D. Every side effect is an AgentEffect.
 *   Integer-Only Math — all token ratios use fixed-point (scale 400).
 */

import type {
  AgentEffect,
  AgentState,
  StepResult,
} from '#/agent/core-effect';

// Re-export canonical types for downstream consumers.
export type { AgentEffect, AgentState, StepResult } from '#/agent/core-effect';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PureCompactionConfig {
  readonly maxTokens: number
  /** Trigger threshold as percentage points (85 = 85.0%). */
  readonly triggerPercent: number
  readonly reservedContextSize: number
  readonly maxCompactionPerTurn: number
}

// ---------------------------------------------------------------------------
// Compaction result
// ---------------------------------------------------------------------------

export interface PureCompactionResult {
  readonly summary: string
  readonly compactedCount: number
  readonly tokensBefore: number
  readonly tokensAfter: number
}

// ---------------------------------------------------------------------------
// Compaction input
// ---------------------------------------------------------------------------

export type CompactionInput =
  | { readonly type: 'TRIGGER'; readonly logicalTick: number }
  | { readonly type: 'LLM_RESULT'; readonly result: PureCompactionResult; readonly logicalTick: number }
  | { readonly type: 'RETRY'; readonly attempt: number; readonly logicalTick: number }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RETRY_ATTEMPTS = 5
const MAX_RETRY_DELAY_MS = 30_000
const RETRY_MIN_TIMEOUT_MS = 300
const RETRY_FACTOR = 2
const RETRY_MAX_TIMEOUT_MS = 5_000
const JITTER_RANGE_MS = 1_000

// ---------------------------------------------------------------------------
// CompactionMessages — result of message splitting
// ---------------------------------------------------------------------------

export interface CompactionMessages {
  readonly messagesToCompact: readonly unknown[]
  readonly recentMessages: readonly unknown[]
  readonly compactedCount: number
}

// ---------------------------------------------------------------------------
// 1. shouldCompact
// ---------------------------------------------------------------------------

/**
 * Determine if compaction should trigger based on current state.
 * Uses integer-only math: `tokens * 400 / maxTokens >= threshold * 4`
 * is equivalent to `tokens / maxTokens >= threshold / 100` without floats.
 *
 * @nim-hook Future integration point for Nim `checkInvariant`:
 *   The Nim native addon can verify compaction invariants (e.g. token
 *   counters are consistent, no negative usage values) via the AXIM
 *   protocol before deciding whether compaction should trigger.
 */
export function shouldCompact(state: AgentState, config: PureCompactionConfig): boolean {
  if (state.compacted) return false
  if (config.maxTokens <= 0) return false

  const { tokenCount } = state
  const { maxTokens, triggerPercent, reservedContextSize } = config

  // Integer ratio check: tokenCount * 400 / maxTokens >= triggerPercent * 4
  const ratioScaled = Math.floor(tokenCount * 400 / maxTokens)
  const thresholdScaled = triggerPercent * 4

  if (ratioScaled >= thresholdScaled) return true

  // Reserved context check: adding reserved would overflow
  if (reservedContextSize > 0 && reservedContextSize < maxTokens) {
    if (tokenCount + reservedContextSize >= maxTokens) return true
  }

  return false
}

// ---------------------------------------------------------------------------
// 2. buildCompactionMessages
// ---------------------------------------------------------------------------

/**
 * Split state.messages into the prefix to compact and the recent suffix to keep.
 * Pure data transformation — no I/O.
 */
export function buildCompactionMessages(
  state: AgentState,
  compactedCount: number,
): CompactionMessages {
  const count = Math.max(0, Math.min(compactedCount, state.messages.length))
  return {
    messagesToCompact: state.messages.slice(0, count),
    recentMessages: state.messages.slice(count),
    compactedCount: count,
  }
}

// ---------------------------------------------------------------------------
// 3. buildCompactionEffects
// ---------------------------------------------------------------------------

/**
 * Return the sequence of effects needed to perform compaction:
 *   1. EMIT_STATUS 'compacting'
 *   2. LOG_RECORD for the begin event
 *   3. LLM_REQUEST with the messages to compact
 */
export function buildCompactionEffects(
  state: AgentState,
  config: PureCompactionConfig,
  compactedCount: number,
): readonly AgentEffect[] {
  const { messagesToCompact } = buildCompactionMessages(state, compactedCount)

  return [
    {
      type: 'EMIT_STATUS',
      status: 'compacting',
    },
    {
      type: 'LOG_RECORD',
      record: {
        type: 'compaction_step.begin',
        tokenCount: state.tokenCount,
        messageCount: state.messages.length,
        compactedCount,
      },
    },
    {
      type: 'LLM_REQUEST',
      messages: messagesToCompact,
      config: {
        maxTokens: config.maxTokens,
        compactedCount,
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// 4. applyCompactionResult
// ---------------------------------------------------------------------------

/**
 * Apply a compaction result to produce a new immutable state.
 * Returns new state with `compacted: true`, updated messages, updated usage.
 *
 * @nim-hook Future integration point for Nim `traceConsequences`:
 *   After applying compaction, the Nim addon can trace the downstream
 *   consequences (e.g. which messages were dropped, how token budgets
 *   shifted) and emit diagnostics for debugging and optimization.
 */
export function applyCompactionResult(
  state: AgentState,
  result: PureCompactionResult,
): AgentState {
  // Replace the compacted prefix with the summary as a single message,
  // keeping the recent messages intact.
  const recent = state.messages.slice(result.compactedCount)
  const summaryMessage = { role: 'system', content: result.summary }
  const newMessages = [summaryMessage, ...recent]

  // Token savings applied to inputOther (non-cached input bucket).
  const savings = result.tokensBefore - result.tokensAfter
  const newUsage = {
    inputOther: state.usage.inputOther + savings,
    output: state.usage.output,
    inputCacheRead: state.usage.inputCacheRead,
    inputCacheCreation: state.usage.inputCacheCreation,
  }

  return {
    ...state,
    compacted: true,
    messages: newMessages,
    tokenCount: result.tokensAfter,
    usage: newUsage,
  }
}

// ---------------------------------------------------------------------------
// 5. buildRetryEffect
// ---------------------------------------------------------------------------

/**
 * Calculate retry delay using integer arithmetic.
 * Returns `null` if max attempts exceeded.
 * `delayMs` is always an integer.
 */
export function buildRetryEffect(
  attempt: number,
  maxAttempts: number,
): AgentEffect | null {
  if (attempt >= maxAttempts) return null

  // Exponential backoff: 300, 600, 1200, 2400, 4800, ...
  const baseDelay = Math.min(
    RETRY_MIN_TIMEOUT_MS * Math.pow(RETRY_FACTOR, attempt),
    RETRY_MAX_TIMEOUT_MS,
  )
  // Integer jitter: 0–999 ms
  const jitter = Math.floor(Math.random() * JITTER_RANGE_MS)
  const delayMs = Math.min(baseDelay + jitter, MAX_RETRY_DELAY_MS)

  return {
    type: 'SCHEDULE_RETRY',
    delayMs,
    payload: { attempt },
  }
}

// ---------------------------------------------------------------------------
// 6. compactionStep — main entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point — orchestrates the above functions.
 * Validates logical tick, routes by input type, returns effects (never throws).
 */
export function compactionStep(
  state: AgentState,
  input: CompactionInput,
  config: PureCompactionConfig,
): StepResult {
  // Validate logical tick
  if (input.logicalTick !== state.logicalTick) {
    return {
      state,
      effects: [
        {
          type: 'LOG_RECORD',
          record: {
            type: 'compaction_step.tick_mismatch',
            expected: state.logicalTick,
            received: input.logicalTick,
          },
        },
      ],
    }
  }

  switch (input.type) {
    case 'TRIGGER': {
      if (!shouldCompact(state, config)) {
        return { state, effects: [] }
      }
      if (state.compacted) {
        return { state, effects: [] }
      }
      const effects = buildCompactionEffects(state, config, state.messages.length)
      return { state, effects }
    }

    case 'LLM_RESULT': {
      const newState = applyCompactionResult(state, input.result)
      const effects: AgentEffect[] = [
        {
          type: 'LOG_RECORD',
          record: {
            type: 'compaction_step.result',
            tokensBefore: input.result.tokensBefore,
            tokensAfter: input.result.tokensAfter,
            compactedCount: input.result.compactedCount,
          },
        },
        {
          type: 'EMIT_STATUS',
          status: 'compacted',
        },
        {
          type: 'COMPACTION_COMPLETE',
          result: input.result,
        },
      ]
      return { state: newState, effects }
    }

    case 'RETRY': {
      const effect = buildRetryEffect(input.attempt, MAX_RETRY_ATTEMPTS)
      if (effect === null) {
        return {
          state,
          effects: [
            {
              type: 'LOG_RECORD',
              record: {
                type: 'compaction_step.max_retries_exceeded',
                attempt: input.attempt,
              },
            },
          ],
        }
      }
      return { state, effects: [effect] }
    }
  }
}
