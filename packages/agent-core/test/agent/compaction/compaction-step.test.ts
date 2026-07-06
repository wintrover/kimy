import { describe, expect, it, vi } from 'vitest';

import {
  type AgentState,
  type PureCompactionConfig,
  type PureCompactionResult,
  type CompactionInput,
  type StepResult,
  MAX_RETRY_ATTEMPTS,
  shouldCompact,
  buildCompactionMessages,
  buildCompactionEffects,
  applyCompactionResult,
  buildRetryEffect,
  compactionStep,
} from '../../../src/agent/compaction/compaction-step';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PureCompactionConfig = {
  maxTokens: 100_000,
  triggerPercent: 85,
  reservedContextSize: 50_000,
  maxCompactionPerTurn: 3,
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: 'execution',
    pendingSwarmParams: null,
    escapeAttempted: false,
    turnCount: 1,
    tokenCount: 50_000,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'how are you' },
    ],
    usage: { inputOther: 1000, output: 500, inputCacheRead: 0, inputCacheCreation: 0 },
    compacted: false,
    logicalTick: 1,
    ...overrides,
  }
}

function makeResult(overrides: Partial<PureCompactionResult> = {}): PureCompactionResult {
  return {
    summary: 'The user greeted the assistant and asked how it is.',
    compactedCount: 2,
    tokensBefore: 80_000,
    tokensAfter: 10_000,
    ...overrides,
  }
}

function tickInput(tick: number): CompactionInput {
  return { type: 'TRIGGER', logicalTick: tick }
}

// ---------------------------------------------------------------------------
// shouldCompact — integer-only token math
// ---------------------------------------------------------------------------

describe('shouldCompact', () => {
  it('returns true when token count exceeds trigger threshold', () => {
    // 90% of 100k = 90k → 90k * 400 / 100k = 360 >= 85 * 4 = 340
    const state = makeState({ tokenCount: 90_000 })
    expect(shouldCompact(state, DEFAULT_CONFIG)).toBe(true)
  })

  it('returns false when token count is below trigger threshold (ratio only)', () => {
    // 50% of 100k = 50k → 50k * 400 / 100k = 200 < 340
    // Use reservedContextSize=0 to isolate ratio check from reserved-context logic
    const config = { ...DEFAULT_CONFIG, reservedContextSize: 0 }
    const state = makeState({ tokenCount: 50_000 })
    expect(shouldCompact(state, config)).toBe(false)
  })

  it('returns true when reserved context would overflow', () => {
    // 51k tokens + 50k reserved = 101k >= 100k max
    // But 51k * 400 / 100k = 204 < 340 (ratio check fails)
    const state = makeState({ tokenCount: 51_000 })
    expect(shouldCompact(state, DEFAULT_CONFIG)).toBe(true)
  })

  it('returns false when already compacted', () => {
    const state = makeState({ tokenCount: 90_000, compacted: true })
    expect(shouldCompact(state, DEFAULT_CONFIG)).toBe(false)
  })

  it('returns false when maxTokens is zero', () => {
    const state = makeState({ tokenCount: 1_000 })
    expect(shouldCompact(state, { ...DEFAULT_CONFIG, maxTokens: 0 })).toBe(false)
  })

  it('returns false when reservedContextSize is not smaller than maxTokens', () => {
    // reservedContextSize (100k) >= maxTokens (100k) → reserved check disabled
    const config = { ...DEFAULT_CONFIG, reservedContextSize: 100_000 }
    const state = makeState({ tokenCount: 80_000 })
    // 80k * 400 / 100k = 320 < 340 → false
    expect(shouldCompact(state, config)).toBe(false)
  })

  it('returns false when reservedContextSize is zero', () => {
    // No reserved context check; rely on ratio only
    const config = { ...DEFAULT_CONFIG, reservedContextSize: 0 }
    const state = makeState({ tokenCount: 51_000 })
    // 51k * 400 / 100k = 204 < 340 → false
    expect(shouldCompact(state, config)).toBe(false)
  })

  it('uses integer math at exact boundary', () => {
    // triggerPercent=85 → thresholdScaled = 85 * 4 = 340
    // Need tokenCount * 400 / maxTokens >= 340
    // tokenCount = 85000 → 85000 * 400 / 100000 = 34000 / 100 = 340 → equal → true
    const state = makeState({ tokenCount: 85_000 })
    expect(shouldCompact(state, DEFAULT_CONFIG)).toBe(true)
  })

  it('returns false one token below boundary (ratio only)', () => {
    // tokenCount = 84999 → 84999 * 400 / 100000 = 339 (floor)
    // 339 < 340 → false
    // Use reservedContextSize=0 to isolate ratio check from reserved-context logic
    const config = { ...DEFAULT_CONFIG, reservedContextSize: 0 }
    const state = makeState({ tokenCount: 84_999 })
    expect(shouldCompact(state, config)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildCompactionMessages
// ---------------------------------------------------------------------------

describe('buildCompactionMessages', () => {
  it('splits messages at compactedCount boundary', () => {
    const state = makeState({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    })
    const result = buildCompactionMessages(state, 2)

    expect(result.compactedCount).toBe(2)
    expect(result.messagesToCompact).toHaveLength(2)
    expect(result.recentMessages).toHaveLength(1)
    expect(result.messagesToCompact[0]).toEqual({ role: 'user', content: 'a' })
    expect(result.messagesToCompact[1]).toEqual({ role: 'assistant', content: 'b' })
    expect(result.recentMessages[0]).toEqual({ role: 'user', content: 'c' })
  })

  it('clamps compactedCount to message length', () => {
    const state = makeState({
      messages: [{ role: 'user', content: 'only one' }],
    })
    const result = buildCompactionMessages(state, 100)

    expect(result.compactedCount).toBe(1)
    expect(result.messagesToCompact).toHaveLength(1)
    expect(result.recentMessages).toHaveLength(0)
  })

  it('returns empty arrays for zero compactedCount', () => {
    const state = makeState()
    const result = buildCompactionMessages(state, 0)

    expect(result.compactedCount).toBe(0)
    expect(result.messagesToCompact).toHaveLength(0)
    expect(result.recentMessages).toHaveLength(state.messages.length)
  })

  it('handles empty messages', () => {
    const state = makeState({ messages: [] })
    const result = buildCompactionMessages(state, 5)

    expect(result.compactedCount).toBe(0)
    expect(result.messagesToCompact).toHaveLength(0)
    expect(result.recentMessages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildCompactionEffects
// ---------------------------------------------------------------------------

describe('buildCompactionEffects', () => {
  it('returns exactly 3 effects in order', () => {
    const state = makeState()
    const effects = buildCompactionEffects(state, DEFAULT_CONFIG, 2)

    expect(effects).toHaveLength(3)
    expect(effects[0]!.type).toBe('EMIT_STATUS')
    expect(effects[1]!.type).toBe('LOG_RECORD')
    expect(effects[2]!.type).toBe('LLM_REQUEST')
  })

  it('EMIT_STATUS has status "compacting"', () => {
    const state = makeState()
    const effects = buildCompactionEffects(state, DEFAULT_CONFIG, 2)
    const emitEffect = effects[0]!

    expect(emitEffect.type).toBe('EMIT_STATUS')
    if (emitEffect.type === 'EMIT_STATUS') {
      expect(emitEffect.status).toBe('compacting')
    }
  })

  it('LLM_REQUEST contains messages to compact', () => {
    const state = makeState({
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'recent' },
      ],
    })
    const effects = buildCompactionEffects(state, DEFAULT_CONFIG, 2)
    const llmEffect = effects[2]!

    expect(llmEffect.type).toBe('LLM_REQUEST')
    if (llmEffect.type === 'LLM_REQUEST') {
      expect(llmEffect.messages).toHaveLength(2)
      expect(llmEffect.messages[0]).toEqual({ role: 'user', content: 'old' })
      expect(llmEffect.messages[1]).toEqual({ role: 'assistant', content: 'old reply' })
    }
  })
})

// ---------------------------------------------------------------------------
// buildRetryEffect
// ---------------------------------------------------------------------------

describe('buildRetryEffect', () => {
  it('returns null when attempt >= maxAttempts', () => {
    expect(buildRetryEffect(5, 5)).toBeNull()
    expect(buildRetryEffect(6, 5)).toBeNull()
    expect(buildRetryEffect(100, 5)).toBeNull()
  })

  it('returns an effect for attempts below max', () => {
    const effect = buildRetryEffect(0, 5)
    expect(effect).not.toBeNull()
    expect(effect!.type).toBe('SCHEDULE_RETRY')
  })

  it('produces integer delayMs', () => {
    // Run multiple times to account for random jitter
    for (let attempt = 0; attempt < 4; attempt++) {
      const effect = buildRetryEffect(attempt, 5)
      expect(effect).not.toBeNull()
      if (effect !== null && effect.type === 'SCHEDULE_RETRY') {
        expect(Number.isInteger(effect.delayMs)).toBe(true)
        expect(effect.delayMs).toBeGreaterThanOrEqual(0)
        expect(effect.delayMs).toBeLessThanOrEqual(30_000)
      }
    }
  })

  it('produces monotonically increasing base delays', () => {
    // With jitter removed (Math.random mocked to 0), delays should increase
    vi.spyOn(Math, 'random').mockReturnValue(0)

    try {
      const effect0 = buildRetryEffect(0, 5)
      const effect1 = buildRetryEffect(1, 5)
      const effect2 = buildRetryEffect(2, 5)

      expect(effect0).not.toBeNull()
      expect(effect1).not.toBeNull()
      expect(effect2).not.toBeNull()

      if (
        effect0 !== null && effect0.type === 'SCHEDULE_RETRY' &&
        effect1 !== null && effect1.type === 'SCHEDULE_RETRY' &&
        effect2 !== null && effect2.type === 'SCHEDULE_RETRY'
      ) {
        expect(effect1.delayMs).toBeGreaterThan(effect0.delayMs)
        expect(effect2.delayMs).toBeGreaterThan(effect1.delayMs)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('clamps delay to MAX_RETRY_DELAY_MS', () => {
    // Mock random to return max jitter (0.999... → 999)
    vi.spyOn(Math, 'random').mockReturnValue(0.999)

    try {
      const effect = buildRetryEffect(4, 5)
      expect(effect).not.toBeNull()
      if (effect !== null && effect.type === 'SCHEDULE_RETRY') {
        expect(effect.delayMs).toBeLessThanOrEqual(30_000)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('returns null for maxAttempts = 0', () => {
    expect(buildRetryEffect(0, 0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyCompactionResult
// ---------------------------------------------------------------------------

describe('applyCompactionResult', () => {
  it('returns a new state object (immutable)', () => {
    const state = makeState()
    const result = makeResult()
    const newState = applyCompactionResult(state, result)

    expect(newState).not.toBe(state)
  })

  it('sets compacted to true', () => {
    const state = makeState({ compacted: false })
    const newState = applyCompactionResult(state, makeResult())

    expect(newState.compacted).toBe(true)
  })

  it('replaces compacted prefix with summary message', () => {
    const state = makeState({
      messages: [
        { role: 'user', content: 'old1' },
        { role: 'assistant', content: 'old2' },
        { role: 'user', content: 'recent' },
      ],
    })
    const result = makeResult({ compactedCount: 2 })
    const newState = applyCompactionResult(state, result)

    expect(newState.messages).toHaveLength(2) // summary + recent
    expect(newState.messages[0]).toEqual({
      role: 'system',
      content: result.summary,
    })
    expect(newState.messages[1]).toEqual({ role: 'user', content: 'recent' })
  })

  it('updates tokenCount to tokensAfter', () => {
    const state = makeState({ tokenCount: 80_000 })
    const result = makeResult({ tokensAfter: 15_000 })
    const newState = applyCompactionResult(state, result)

    expect(newState.tokenCount).toBe(15_000)
  })

  it('updates usage totals (savings applied to inputOther)', () => {
    const state = makeState({
      usage: { inputOther: 1000, output: 500, inputCacheRead: 0, inputCacheCreation: 0 },
    })
    const result = makeResult({ tokensBefore: 80_000, tokensAfter: 10_000 })
    const newState = applyCompactionResult(state, result)

    // Tokens saved = 80000 - 10000 = 70000
    expect(newState.usage.inputOther).toBe(71_000)
    expect(newState.usage.output).toBe(500)
    expect(newState.usage.inputCacheRead).toBe(0)
    expect(newState.usage.inputCacheCreation).toBe(0)
  })

  it('preserves unchanged state fields', () => {
    const state = makeState({ turnCount: 7, phase: 'planning' })
    const newState = applyCompactionResult(state, makeResult())

    expect(newState.turnCount).toBe(7)
    expect(newState.phase).toBe('planning')
    expect(newState.logicalTick).toBe(state.logicalTick)
  })
})

// ---------------------------------------------------------------------------
// compactionStep — TRIGGER input
// ---------------------------------------------------------------------------

describe('compactionStep with TRIGGER', () => {
  it('returns compaction effects when shouldCompact is true', () => {
    const state = makeState({ tokenCount: 90_000 })
    const result = compactionStep(state, tickInput(1), DEFAULT_CONFIG)

    expect(result.effects.length).toBeGreaterThan(0)
    expect(result.effects.some((e) => e.type === 'LLM_REQUEST')).toBe(true)
    expect(result.effects.some((e) => e.type === 'EMIT_STATUS')).toBe(true)
  })

  it('returns empty effects when shouldCompact is false', () => {
    const state = makeState({ tokenCount: 10_000 })
    const result = compactionStep(state, tickInput(1), DEFAULT_CONFIG)

    expect(result.effects).toHaveLength(0)
    expect(result.state).toBe(state)
  })

  it('returns empty effects when already compacted', () => {
    const state = makeState({ tokenCount: 90_000, compacted: true })
    const result = compactionStep(state, tickInput(1), DEFAULT_CONFIG)

    expect(result.effects).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// compactionStep — LLM_RESULT input
// ---------------------------------------------------------------------------

describe('compactionStep with LLM_RESULT', () => {
  it('applies the result and returns completion effects', () => {
    const state = makeState({ tokenCount: 80_000 })
    const result = makeResult()
    const stepResult = compactionStep(
      state,
      { type: 'LLM_RESULT', result, logicalTick: 1 },
      DEFAULT_CONFIG,
    )

    expect(stepResult.state.compacted).toBe(true)
    expect(stepResult.state.messages[0]).toEqual({
      role: 'system',
      content: result.summary,
    })
    expect(stepResult.effects.some((e) => e.type === 'COMPACTION_COMPLETE')).toBe(true)
    expect(stepResult.effects.some((e) => e.type === 'EMIT_STATUS')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// compactionStep — RETRY input
// ---------------------------------------------------------------------------

describe('compactionStep with RETRY', () => {
  it('returns a retry effect for attempts below max', () => {
    const state = makeState()
    const result = compactionStep(
      state,
      { type: 'RETRY', attempt: 0, logicalTick: 1 },
      DEFAULT_CONFIG,
    )

    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]!.type).toBe('SCHEDULE_RETRY')
  })

  it('returns a log effect when max retries exceeded', () => {
    const state = makeState()
    const result = compactionStep(
      state,
      { type: 'RETRY', attempt: 5, logicalTick: 1 },
      DEFAULT_CONFIG,
    )

    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]!.type).toBe('LOG_RECORD')
  })

  it('does not mutate state on retry', () => {
    const state = makeState()
    const result = compactionStep(
      state,
      { type: 'RETRY', attempt: 1, logicalTick: 1 },
      DEFAULT_CONFIG,
    )

    expect(result.state).toBe(state)
  })
})

// ---------------------------------------------------------------------------
// compactionStep — tick validation
// ---------------------------------------------------------------------------

describe('compactionStep tick validation', () => {
  it('rejects TRIGGER with mismatched tick', () => {
    const state = makeState({ logicalTick: 3 })
    const result = compactionStep(state, tickInput(5), DEFAULT_CONFIG)

    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]!.type).toBe('LOG_RECORD')
    expect(result.state).toBe(state)
  })

  it('rejects LLM_RESULT with mismatched tick', () => {
    const state = makeState({ logicalTick: 2 })
    const result = compactionStep(
      state,
      { type: 'LLM_RESULT', result: makeResult(), logicalTick: 7 },
      DEFAULT_CONFIG,
    )

    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]!.type).toBe('LOG_RECORD')
  })

  it('rejects RETRY with mismatched tick', () => {
    const state = makeState({ logicalTick: 1 })
    const result = compactionStep(
      state,
      { type: 'RETRY', attempt: 0, logicalTick: 99 },
      DEFAULT_CONFIG,
    )

    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]!.type).toBe('LOG_RECORD')
  })

  it('accepts matching tick', () => {
    const state = makeState({ tokenCount: 90_000, logicalTick: 4 })
    const result = compactionStep(state, tickInput(4), DEFAULT_CONFIG)

    // Should NOT be a tick mismatch — should get compaction effects
    expect(result.effects.some((e) => e.type === 'LLM_REQUEST')).toBe(true)
  })
})
