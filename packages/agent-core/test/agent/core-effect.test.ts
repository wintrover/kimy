import { describe, expect, it } from 'vitest';

import {
  createInitialAgentState,
  type AgentEffect,
  type AgentInput,
  type AgentState,
  type PureStepFunction,
  type StepResult,
} from '../../src/agent/core-effect';

// ---------------------------------------------------------------------------
// createInitialAgentState
// ---------------------------------------------------------------------------

describe('createInitialAgentState', () => {
  it('returns correct defaults', () => {
    const state = createInitialAgentState();

    expect(state.pendingSwarmParams).toBeNull();
    expect(state.escapeAttempted).toBe(false);
    expect(state.turnCount).toBe(0);
    expect(state.tokenCount).toBe(0);
    expect(state.messages).toEqual([]);
    expect(state.compacted).toBe(false);
    expect(state.usage).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('starts with logicalTick = 0', () => {
    const state = createInitialAgentState();
    expect(state.logicalTick).toBe(0);
  });

  it('starts with phase = planning', () => {
    const state = createInitialAgentState();
    expect(state.phase).toBe('planning');
  });
});

// ---------------------------------------------------------------------------
// AgentEffect — discriminated union type narrowing
// ---------------------------------------------------------------------------

describe('AgentEffect', () => {
  function assertEffect(effect: AgentEffect): string {
    switch (effect.type) {
      case 'CALL_TOOL':
        return 'tool:' + effect.toolName;
      case 'SEND_EVENT':
        return 'event:' + effect.event;
      case 'LLM_REQUEST':
        return 'llm';
      case 'SCHEDULE_RETRY':
        return 'retry:' + effect.delayMs;
      case 'READ_FILE':
        return 'read:' + effect.path;
      case 'WRITE_FILE':
        return 'write:' + effect.path;
      case 'EMIT_STATUS':
        return 'status:' + effect.status;
      case 'LOG_RECORD':
        return 'log';
      case 'BEGIN_TURN':
        return 'begin:' + effect.turnId;
      case 'END_TURN':
        return 'end:' + effect.turnId;
      case 'RESET_TO_PLANNING':
        return 'reset';
      case 'APPEND_MESSAGE':
        return 'append';
      case 'COMPACTION_COMPLETE':
        return 'compact';
    }
  }

  it('narrows CALL_TOOL correctly', () => {
    const effect: AgentEffect = { type: 'CALL_TOOL', toolName: 'Bash', args: { command: 'ls' } };
    expect(effect.type).toBe('CALL_TOOL');
    expect(effect.toolName).toBe('Bash');
    expect(assertEffect(effect)).toBe('tool:Bash');
  });

  it('narrows SEND_EVENT correctly', () => {
    const effect: AgentEffect = { type: 'SEND_EVENT', event: 'status', payload: { ok: true } };
    expect(effect.type).toBe('SEND_EVENT');
    expect(effect.event).toBe('status');
    expect(assertEffect(effect)).toBe('event:status');
  });

  it('narrows LLM_REQUEST correctly', () => {
    const effect: AgentEffect = { type: 'LLM_REQUEST', messages: [], config: {} };
    expect(effect.type).toBe('LLM_REQUEST');
    expect(assertEffect(effect)).toBe('llm');
  });

  it('narrows SCHEDULE_RETRY correctly', () => {
    const effect: AgentEffect = { type: 'SCHEDULE_RETRY', delayMs: 1000, payload: {} };
    expect(effect.type).toBe('SCHEDULE_RETRY');
    expect(effect.delayMs).toBe(1000);
    expect(assertEffect(effect)).toBe('retry:1000');
  });

  it('narrows READ_FILE correctly', () => {
    const effect: AgentEffect = { type: 'READ_FILE', path: '/foo/bar.ts' };
    expect(effect.type).toBe('READ_FILE');
    expect(effect.path).toBe('/foo/bar.ts');
    expect(assertEffect(effect)).toBe('read:/foo/bar.ts');
  });

  it('narrows WRITE_FILE correctly', () => {
    const effect: AgentEffect = { type: 'WRITE_FILE', path: '/foo/bar.ts', content: 'hello' };
    expect(effect.type).toBe('WRITE_FILE');
    expect(effect.content).toBe('hello');
    expect(assertEffect(effect)).toBe('write:/foo/bar.ts');
  });

  it('narrows EMIT_STATUS correctly', () => {
    const effect: AgentEffect = { type: 'EMIT_STATUS', status: 'running' };
    expect(effect.type).toBe('EMIT_STATUS');
    expect(assertEffect(effect)).toBe('status:running');
  });

  it('narrows LOG_RECORD correctly', () => {
    const effect: AgentEffect = { type: 'LOG_RECORD', record: { msg: 'hi' } };
    expect(effect.type).toBe('LOG_RECORD');
    expect(assertEffect(effect)).toBe('log');
  });

  it('narrows BEGIN_TURN correctly', () => {
    const effect: AgentEffect = { type: 'BEGIN_TURN', turnId: 3 };
    expect(effect.type).toBe('BEGIN_TURN');
    expect(effect.turnId).toBe(3);
    expect(assertEffect(effect)).toBe('begin:3');
  });

  it('narrows END_TURN correctly', () => {
    const effect: AgentEffect = { type: 'END_TURN', turnId: 3, reason: 'done' };
    expect(effect.type).toBe('END_TURN');
    expect(effect.turnId).toBe(3);
    expect(effect.reason).toBe('done');
    expect(assertEffect(effect)).toBe('end:3');
  });

  it('narrows RESET_TO_PLANNING correctly', () => {
    const effect: AgentEffect = { type: 'RESET_TO_PLANNING' };
    expect(effect.type).toBe('RESET_TO_PLANNING');
    expect(assertEffect(effect)).toBe('reset');
  });

  it('narrows APPEND_MESSAGE correctly', () => {
    const effect: AgentEffect = { type: 'APPEND_MESSAGE', message: { text: 'hi' } };
    expect(effect.type).toBe('APPEND_MESSAGE');
    expect(assertEffect(effect)).toBe('append');
  });

  it('narrows COMPACTION_COMPLETE correctly', () => {
    const effect: AgentEffect = { type: 'COMPACTION_COMPLETE', result: { summary: 'ok' } };
    expect(effect.type).toBe('COMPACTION_COMPLETE');
    expect(assertEffect(effect)).toBe('compact');
  });
});

// ---------------------------------------------------------------------------
// AgentInput — every variant carries logicalTick
// ---------------------------------------------------------------------------

describe('AgentInput', () => {
  function getTick(input: AgentInput): number {
    return input.logicalTick;
  }

  it('USER_MESSAGE carries logicalTick', () => {
    const input: AgentInput = { type: 'USER_MESSAGE', content: 'hi', logicalTick: 5 };
    expect(input.type).toBe('USER_MESSAGE');
    expect(getTick(input)).toBe(5);
  });

  it('TOOL_RESULT carries logicalTick', () => {
    const input: AgentInput = { type: 'TOOL_RESULT', toolName: 'Bash', result: 'ok', logicalTick: 10 };
    expect(input.type).toBe('TOOL_RESULT');
    expect(getTick(input)).toBe(10);
  });

  it('LLM_RESPONSE carries logicalTick', () => {
    const input: AgentInput = { type: 'LLM_RESPONSE', response: { text: 'done' }, logicalTick: 3 };
    expect(input.type).toBe('LLM_RESPONSE');
    expect(getTick(input)).toBe(3);
  });

  it('COMPACTION_TRIGGER carries logicalTick', () => {
    const input: AgentInput = { type: 'COMPACTION_TRIGGER', logicalTick: 7 };
    expect(input.type).toBe('COMPACTION_TRIGGER');
    expect(getTick(input)).toBe(7);
  });

  it('PHASE_TRANSITION carries logicalTick', () => {
    const input: AgentInput = { type: 'PHASE_TRANSITION', target: 'execution', logicalTick: 1 };
    expect(input.type).toBe('PHASE_TRANSITION');
    expect(getTick(input)).toBe(1);
  });

  it('INIT carries logicalTick', () => {
    const input: AgentInput = { type: 'INIT', logicalTick: 0 };
    expect(input.type).toBe('INIT');
    expect(getTick(input)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PureStepFunction signature compliance
// ---------------------------------------------------------------------------

describe('PureStepFunction', () => {
  it('accepts a conforming step function', () => {
    const noop: PureStepFunction = (state, _input) => {
      return { state, effects: [] };
    };

    const state = createInitialAgentState();
    const input: AgentInput = { type: 'INIT', logicalTick: 0 };
    const result: StepResult = noop(state, input);

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });
});
