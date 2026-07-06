import { describe, expect, it } from 'vitest';

import {
  validateTick,
  classifyTurnInput,
  buildTurnEffects,
  advanceState,
  turnStep,
  createInitialState,
} from '#/agent/turn/turn-step';

import type {
  AgentState,
  AgentInput,
  AgentEffect,
} from '#/agent/core-effect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateAt(tick: number, overrides?: Partial<AgentState>): AgentState {
  return createInitialState({ logicalTick: tick, ...overrides });
}

function inputAt(type: AgentInput['type'], tick: number): AgentInput {
  switch (type) {
    case 'INIT':
      return { type: 'INIT', logicalTick: tick };
    case 'USER_MESSAGE':
      return { type: 'USER_MESSAGE', content: 'hello', logicalTick: tick };
    case 'TOOL_RESULT':
      return { type: 'TOOL_RESULT', toolName: 'Bash', result: 'ok', logicalTick: tick };
    case 'LLM_RESPONSE':
      return { type: 'LLM_RESPONSE', response: {}, logicalTick: tick };
    case 'COMPACTION_TRIGGER':
      return { type: 'COMPACTION_TRIGGER', logicalTick: tick };
    case 'PHASE_TRANSITION':
      return { type: 'PHASE_TRANSITION', target: 'planning', logicalTick: tick };
  }
}

// ---------------------------------------------------------------------------
// validateTick
// ---------------------------------------------------------------------------

describe('validateTick', () => {
  it('accepts valid sequential ticks', () => {
    expect(validateTick(stateAt(0), inputAt('INIT', 1))).toBeNull();
    expect(validateTick(stateAt(1), inputAt('USER_MESSAGE', 2))).toBeNull();
    expect(validateTick(stateAt(42), inputAt('TOOL_RESULT', 43))).toBeNull();
  });

  it('rejects out-of-order ticks (too low)', () => {
    const msg = validateTick(stateAt(5), inputAt('INIT', 3));
    expect(msg).toBe('Logical tick mismatch: expected 6, got 3');
  });

  it('rejects out-of-order ticks (too high — skip)', () => {
    const msg = validateTick(stateAt(0), inputAt('INIT', 5));
    expect(msg).toBe('Logical tick mismatch: expected 1, got 5');
  });

  it('rejects same tick (no advance)', () => {
    const msg = validateTick(stateAt(3), inputAt('INIT', 3));
    expect(msg).toBe('Logical tick mismatch: expected 4, got 3');
  });
});

// ---------------------------------------------------------------------------
// classifyTurnInput
// ---------------------------------------------------------------------------

describe('classifyTurnInput', () => {
  it('classifies INIT', () => {
    expect(classifyTurnInput(inputAt('INIT', 1))).toBe('init');
  });

  it('classifies USER_MESSAGE', () => {
    expect(classifyTurnInput(inputAt('USER_MESSAGE', 1))).toBe('user_message');
  });

  it('classifies TOOL_RESULT', () => {
    expect(classifyTurnInput(inputAt('TOOL_RESULT', 1))).toBe('tool_result');
  });

  it('classifies LLM_RESPONSE', () => {
    expect(classifyTurnInput(inputAt('LLM_RESPONSE', 1))).toBe('llm_response');
  });

  it('classifies COMPACTION_TRIGGER', () => {
    expect(classifyTurnInput(inputAt('COMPACTION_TRIGGER', 1))).toBe('compaction_trigger');
  });

  it('classifies PHASE_TRANSITION', () => {
    expect(classifyTurnInput(inputAt('PHASE_TRANSITION', 1))).toBe('phase_transition');
  });
});

// ---------------------------------------------------------------------------
// turnStep — INIT input
// ---------------------------------------------------------------------------

describe('turnStep with INIT input', () => {
  it('returns correct effects at tick 1', () => {
    const result = turnStep(stateAt(0), inputAt('INIT', 1));

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toEqual({
      type: 'LOG_RECORD',
      record: { type: 'turn.init', logicalTick: 1 },
    });
  });

  it('advances logicalTick by 1', () => {
    const result = turnStep(stateAt(0), inputAt('INIT', 1));
    expect(result.state.logicalTick).toBe(1);
  });

  it('preserves phase', () => {
    const result = turnStep(stateAt(0), inputAt('INIT', 1));
    expect(result.state.phase).toBe('planning');
  });
});

// ---------------------------------------------------------------------------
// turnStep — USER_MESSAGE
// ---------------------------------------------------------------------------

describe('turnStep with USER_MESSAGE input', () => {
  it('produces APPEND_MESSAGE, EMIT_STATUS, and LOG_RECORD effects', () => {
    const result = turnStep(stateAt(0), inputAt('USER_MESSAGE', 1));
    const types = result.effects.map(e => e.type);

    expect(types).toContain('APPEND_MESSAGE');
    expect(types).toContain('EMIT_STATUS');
    expect(types).toContain('LOG_RECORD');
  });

  it('requests LLM when in planning phase', () => {
    const result = turnStep(stateAt(0, { phase: 'planning' }), inputAt('USER_MESSAGE', 1));
    const hasLLM = result.effects.some(e => e.type === 'LLM_REQUEST');
    expect(hasLLM).toBe(true);
  });

  it('does not request LLM when in execution phase', () => {
    const result = turnStep(
      stateAt(0, { phase: 'execution' }),
      inputAt('USER_MESSAGE', 1),
    );
    const hasLLM = result.effects.some(e => e.type === 'LLM_REQUEST');
    expect(hasLLM).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// turnStep — TOOL_RESULT
// ---------------------------------------------------------------------------

describe('turnStep with TOOL_RESULT input', () => {
  it('requests LLM in execution phase', () => {
    const result = turnStep(
      stateAt(0, { phase: 'execution' }),
      inputAt('TOOL_RESULT', 1),
    );
    const hasLLM = result.effects.some(e => e.type === 'LLM_REQUEST');
    expect(hasLLM).toBe(true);
  });

  it('does not request LLM in planning phase', () => {
    const result = turnStep(stateAt(0, { phase: 'planning' }), inputAt('TOOL_RESULT', 1));
    const hasLLM = result.effects.some(e => e.type === 'LLM_REQUEST');
    expect(hasLLM).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// turnStep — LLM_RESPONSE
// ---------------------------------------------------------------------------

describe('turnStep with LLM_RESPONSE input', () => {
  it('emits turn_completed status', () => {
    const result = turnStep(stateAt(0), inputAt('LLM_RESPONSE', 1));
    const statusEffects = result.effects.filter(e => e.type === 'EMIT_STATUS');
    expect(statusEffects).toHaveLength(1);
    expect(statusEffects[0]).toEqual({ type: 'EMIT_STATUS', status: 'turn_completed' });
  });
});

// ---------------------------------------------------------------------------
// turnStep — tick error
// ---------------------------------------------------------------------------

describe('turnStep tick validation error', () => {
  it('returns error event for mismatched tick', () => {
    const result = turnStep(stateAt(5), inputAt('INIT', 5));
    const hasErrorEvent = result.effects.some(
      e => e.type === 'SEND_EVENT' && e.event === 'error',
    );
    expect(hasErrorEvent).toBe(true);
  });

  it('advances tick even on error (total function)', () => {
    const result = turnStep(stateAt(5), inputAt('INIT', 5));
    expect(result.state.logicalTick).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// advanceState — immutability
// ---------------------------------------------------------------------------

describe('advanceState', () => {
  it('produces new object (no mutation of original)', () => {
    const original = stateAt(0);
    const next = advanceState(original, []);
    expect(next).not.toBe(original);
    expect(original.logicalTick).toBe(0);
    expect(next.logicalTick).toBe(1);
  });

  it('increments turnCount on BEGIN_TURN effect', () => {
    const original = stateAt(0, { turnCount: 3 });
    const next = advanceState(original, [{ type: 'BEGIN_TURN', turnId: 1 }]);
    expect(next.turnCount).toBe(4);
  });

  it('resets phase to planning on RESET_TO_PLANNING', () => {
    const original = stateAt(0, { phase: 'execution', escapeAttempted: true });
    const next = advanceState(original, [{ type: 'RESET_TO_PLANNING' }]);
    expect(next.phase).toBe('planning');
    expect(next.escapeAttempted).toBe(false);
  });

  it('preserves all other fields unchanged', () => {
    const original = stateAt(0, {
      pendingSwarmParams: { key: 'value' },
      messages: [{ role: 'user' }],
      tokenCount: 5000,
      usage: { inputOther: 10, output: 20, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const next = advanceState(original, []);
    expect(next.pendingSwarmParams).toEqual({ key: 'value' });
    expect(next.messages).toEqual([{ role: 'user' }]);
    expect(next.tokenCount).toBe(5000);
    expect(next.usage).toEqual({ inputOther: 10, output: 20, inputCacheRead: 0, inputCacheCreation: 0 });
  });
});

// ---------------------------------------------------------------------------
// createInitialState
// ---------------------------------------------------------------------------

describe('createInitialState', () => {
  it('creates a valid initial state at tick 0', () => {
    const s = createInitialState();
    expect(s.logicalTick).toBe(0);
    expect(s.phase).toBe('planning');
    expect(s.turnCount).toBe(0);
    expect(s.compacted).toBe(false);
    expect(s.escapeAttempted).toBe(false);
    expect(s.pendingSwarmParams).toBeNull();
    expect(s.tokenCount).toBe(0);
    expect(s.messages).toEqual([]);
  });

  it('allows partial overrides', () => {
    const s = createInitialState({ phase: 'execution', turnCount: 5 });
    expect(s.phase).toBe('execution');
    expect(s.turnCount).toBe(5);
    expect(s.logicalTick).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-step sequence
// ---------------------------------------------------------------------------

describe('multi-step turn sequence', () => {
  it('runs INIT → USER_MESSAGE → LLM_RESPONSE correctly', () => {
    let state = createInitialState();

    const r1 = turnStep(state, inputAt('INIT', 1));
    expect(r1.effects[0]!.type).toBe('LOG_RECORD');
    state = r1.state;

    const r2 = turnStep(state, inputAt('USER_MESSAGE', 2));
    expect(r2.effects.some(e => e.type === 'LLM_REQUEST')).toBe(true);
    state = r2.state;

    const r3 = turnStep(state, inputAt('LLM_RESPONSE', 3));
    expect(r3.effects.some(e => e.type === 'EMIT_STATUS')).toBe(true);
    expect(r3.state.logicalTick).toBe(3);
  });
});
