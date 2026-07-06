import { describe, expect, it, vi } from 'vitest';

import {
  createTickCounter,
  executeEffect,
  executeEffects,
  runLoop,
  type RuntimeContext,
} from '../../src/agent/imperative-shell';

import type {
  AgentEffect,
  AgentInput,
  AgentState,
  PureStepFunction,
} from '../../src/agent/core-effect';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
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
  }
}

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    agent: {
      emitStatusUpdated: vi.fn(),
      records: { logRecord: vi.fn() },
    },
    executeTool: vi.fn().mockResolvedValue({ output: 'tool-ok' }),
    generate: vi.fn().mockResolvedValue({ content: 'llm-ok' }),
    readFile: vi.fn().mockResolvedValue('file-content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as RuntimeContext
}

/** Minimal step function that echoes the input back as a message and returns no effects. */
function echoStep(state: AgentState, input: AgentInput): { state: AgentState; effects: readonly AgentEffect[] } {
  return {
    state: { ...state, messages: [...state.messages, input], logicalTick: input.logicalTick },
    effects: [],
  }
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

// ─── createTickCounter ───────────────────────────────────────────────────────

describe('createTickCounter', () => {
  it('starts at 0 by default and increments sequentially', () => {
    const tc = createTickCounter();
    expect(tc.current()).toBe(0);
    expect(tc.next()).toBe(1);
    expect(tc.next()).toBe(2);
    expect(tc.next()).toBe(3);
    expect(tc.current()).toBe(3);
  });

  it('starts from a given initial tick', () => {
    const tc = createTickCounter(10);
    expect(tc.current()).toBe(10);
    expect(tc.next()).toBe(11);
    expect(tc.next()).toBe(12);
    expect(tc.current()).toBe(12);
  });

  it('produces strictly monotonic integers', () => {
    const tc = createTickCounter(0);
    const ticks: number[] = [];
    for (let i = 0; i < 100; i++) {
      ticks.push(tc.next());
    }
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBe(ticks[i - 1]! + 1);
    }
  });
});

// ─── executeEffect ───────────────────────────────────────────────────────────

describe('executeEffect', () => {
  it('EMIT_STATUS calls agent.emitStatusUpdated and returns null', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'EMIT_STATUS', status: 'ready' },
      ctx,
      tc,
    );
    expect(result).toBeNull();
    expect(ctx.agent.emitStatusUpdated).toHaveBeenCalledTimes(1);
  });

  it('LOG_RECORD calls records.logRecord and returns null', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const record = { type: 'turn.prompt', data: 'hello' };
    const result = await executeEffect(
      { type: 'LOG_RECORD', record },
      ctx,
      tc,
    );
    expect(result).toBeNull();
    expect(ctx.agent.records.logRecord).toHaveBeenCalledWith(record);
  });

  it('SEND_EVENT calls rpc.sendEvent and returns null', async () => {
    const sendEvent = vi.fn();
    const ctx = makeCtx({ agent: { emitStatusUpdated: vi.fn(), records: { logRecord: vi.fn() }, rpc: { sendEvent } } });
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'SEND_EVENT', event: 'test.event', payload: { key: 'val' } },
      ctx,
      tc,
    );
    expect(result).toBeNull();
    expect(sendEvent).toHaveBeenCalledWith('test.event', { key: 'val' });
  });

  it('CALL_TOOL executes tool and returns TOOL_RESULT', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'CALL_TOOL', toolName: 'Bash', args: { command: 'ls' } },
      ctx,
      tc,
    );
    expect(ctx.executeTool).toHaveBeenCalledWith('Bash', { command: 'ls' });
    expect(result).toEqual({
      type: 'TOOL_RESULT',
      toolName: 'Bash',
      result: { output: 'tool-ok' },
      logicalTick: 1,
    });
  });

  it('LLM_REQUEST generates and returns LLM_RESPONSE', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const messages = [{ role: 'user', content: 'hi' }];
    const config = { model: 'test' };
    const result = await executeEffect(
      { type: 'LLM_REQUEST', messages, config },
      ctx,
      tc,
    );
    expect(ctx.generate).toHaveBeenCalledWith(messages, config);
    expect(result).toEqual({
      type: 'LLM_RESPONSE',
      response: { content: 'llm-ok' },
      logicalTick: 1,
    });
  });

  it('SCHEDULE_RETRY sleeps and returns null', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'SCHEDULE_RETRY', delayMs: 500, payload: {} },
      ctx,
      tc,
    );
    expect(ctx.sleep).toHaveBeenCalledWith(500);
    expect(result).toBeNull();
  });

  it('READ_FILE reads and returns TOOL_RESULT with read_file toolName', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'READ_FILE', path: '/tmp/test.txt' },
      ctx,
      tc,
    );
    expect(ctx.readFile).toHaveBeenCalledWith('/tmp/test.txt');
    expect(result).toEqual({
      type: 'TOOL_RESULT',
      toolName: 'read_file',
      result: 'file-content',
      logicalTick: 1,
    });
  });

  it('WRITE_FILE writes and returns null', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'WRITE_FILE', path: '/tmp/out.txt', content: 'hello' },
      ctx,
      tc,
    );
    expect(ctx.writeFile).toHaveBeenCalledWith('/tmp/out.txt', 'hello');
    expect(result).toBeNull();
  });

  it('catches errors from side effects and returns null', async () => {
    const ctx = makeCtx({
      executeTool: vi.fn().mockRejectedValue(new Error('tool crashed')),
    });
    const tc = createTickCounter();
    const result = await executeEffect(
      { type: 'CALL_TOOL', toolName: 'Bash', args: {} },
      ctx,
      tc,
    );
    expect(result).toBeNull();
  });

  it('tick counter increments on every call, even when effect returns null', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter(5);

    await executeEffect({ type: 'EMIT_STATUS', status: 'x' }, ctx, tc);
    expect(tc.current()).toBe(6);

    await executeEffect({ type: 'LOG_RECORD', record: {} }, ctx, tc);
    expect(tc.current()).toBe(7);

    const result = await executeEffect(
      { type: 'CALL_TOOL', toolName: 'X', args: {} },
      ctx,
      tc,
    );
    expect(result!.logicalTick).toBe(8);
  });

  it('returns null for turn/compaction effects (fire-and-forget)', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();

    const beginResult = await executeEffect({ type: 'BEGIN_TURN', turnId: 1 }, ctx, tc);
    expect(beginResult).toBeNull();

    const endResult = await executeEffect({ type: 'END_TURN', turnId: 1, reason: 'done' }, ctx, tc);
    expect(endResult).toBeNull();

    const resetResult = await executeEffect({ type: 'RESET_TO_PLANNING' }, ctx, tc);
    expect(resetResult).toBeNull();

    const appendResult = await executeEffect({ type: 'APPEND_MESSAGE', message: {} }, ctx, tc);
    expect(appendResult).toBeNull();

    const compactResult = await executeEffect({ type: 'COMPACTION_COMPLETE', result: {} }, ctx, tc);
    expect(compactResult).toBeNull();
  });
});

// ─── executeEffects ──────────────────────────────────────────────────────────

describe('executeEffects', () => {
  it('executes effects in order and collects inputs', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const effects: AgentEffect[] = [
      { type: 'EMIT_STATUS', status: 'a' },
      { type: 'CALL_TOOL', toolName: 'T1', args: {} },
      { type: 'LOG_RECORD', record: { x: 1 } },
      { type: 'CALL_TOOL', toolName: 'T2', args: {} },
    ];

    const inputs = await executeEffects(effects, ctx, tc);

    // Fire-and-forget effects don't produce inputs
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.type).toBe('TOOL_RESULT');
    expect((inputs[0]! as { toolName: string }).toolName).toBe('T1');
    expect(inputs[1]!.type).toBe('TOOL_RESULT');
    expect((inputs[1]! as { toolName: string }).toolName).toBe('T2');

    // Verify order: emitStatus, then tool, then logRecord, then tool
    expect(ctx.agent.emitStatusUpdated).toHaveBeenCalledTimes(1);
    expect(ctx.agent.records.logRecord).toHaveBeenCalledTimes(1);
    expect(ctx.executeTool).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for no effects', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter();
    const inputs = await executeEffects([], ctx, tc);
    expect(inputs).toEqual([]);
  });

  it('tick counter advances for every effect, not just result-producing ones', async () => {
    const ctx = makeCtx();
    const tc = createTickCounter(0);

    await executeEffects(
      [
        { type: 'EMIT_STATUS', status: 'a' },
        { type: 'EMIT_STATUS', status: 'b' },
        { type: 'LOG_RECORD', record: {} },
      ],
      ctx,
      tc,
    );

    expect(tc.current()).toBe(3);
  });
});

// ─── runLoop ─────────────────────────────────────────────────────────────────

describe('runLoop', () => {
  it('processes external inputs through the step function', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const inputs = [
      { type: 'USER_MESSAGE' as const, content: 'hello', logicalTick: 0 },
      { type: 'USER_MESSAGE' as const, content: 'world', logicalTick: 0 },
    ];

    const final = await runLoop(state, echoStep, ctx, fromArray(inputs));

    expect(final.messages).toHaveLength(2);
  });

  it('respects maxIterations', async () => {
    const ctx = makeCtx();
    const state = makeState();
    // Create more inputs than the limit
    const inputs: AgentInput[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'USER_MESSAGE',
      content: `msg-${i}`,
      logicalTick: 0,
    }));

    const final = await runLoop(state, echoStep, ctx, fromArray(inputs), 5);

    // Should have stopped at 5
    expect(final.messages).toHaveLength(5);
  });

  it('executes effects produced by the step function', async () => {
    const ctx = makeCtx();
    const state = makeState();

    const stepWithEffects: PureStepFunction = (s, input) => ({
      state: { ...s, logicalTick: input.logicalTick },
      effects: [{ type: 'CALL_TOOL', toolName: 'TestTool', args: { x: 1 } }],
    });

    const inputs = [{ type: 'USER_MESSAGE' as const, content: 'trigger', logicalTick: 0 }];
    await runLoop(state, stepWithEffects, ctx, fromArray(inputs));

    expect(ctx.executeTool).toHaveBeenCalledWith('TestTool', { x: 1 });
  });

  it('feeds internal tool results back into the step function', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const receivedInputs: AgentInput[] = [];

    const trackingStep: PureStepFunction = (s, input) => {
      receivedInputs.push(input);
      return {
        state: { ...s, logicalTick: input.logicalTick },
        effects: [{ type: 'EMIT_STATUS', status: 'ok' }],
      };
    };

    const inputs = [{ type: 'USER_MESSAGE' as const, content: 'go', logicalTick: 0 }];
    await runLoop(state, trackingStep, ctx, fromArray(inputs));

    // First: the external USER_MESSAGE
    expect(receivedInputs[0]!.type).toBe('USER_MESSAGE');
    // Second: the internal EMIT_STATUS produces no TOOL_RESULT (fire-and-forget),
    // so no second input is fed back
    expect(receivedInputs).toHaveLength(1);
  });

  it('tick counter starts from initial state logicalTick', async () => {
    const ctx = makeCtx();
    const state = makeState({ logicalTick: 42 });
    const receivedInputs: AgentInput[] = [];

    // Step function: on first call, emit a CALL_TOOL effect so the shell
    // stamps it with the tick counter; on second call (the TOOL_RESULT fed
    // back), record its logicalTick to verify it was stamped from 42.
    const stepWithTracking: PureStepFunction = (s, input) => {
      receivedInputs.push(input);
      if (receivedInputs.length === 1) {
        return {
          state: { ...s, logicalTick: input.logicalTick },
          effects: [{ type: 'CALL_TOOL', toolName: 'Probe', args: {} }],
        };
      }
      return {
        state: { ...s, logicalTick: input.logicalTick },
        effects: [],
      };
    };

    const inputs = [{ type: 'USER_MESSAGE' as const, content: 'go', logicalTick: 0 }];
    await runLoop(state, stepWithTracking, ctx, fromArray(inputs));

    // External input has logicalTick: 0; the TOOL_RESULT fed back should be
    // stamped 43 (counter starts at 42, next() → 43).
    const toolResult = receivedInputs[1];
    expect(toolResult!.type).toBe('TOOL_RESULT');
    expect(toolResult!.logicalTick).toBe(43);
  });

  it('feeds internal TOOL_RESULT back into the step function', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const receivedInputs: AgentInput[] = [];

    const trackingStep: PureStepFunction = (s, input) => {
      receivedInputs.push(input);
      if (input.type === 'USER_MESSAGE') {
        return {
          state: { ...s, logicalTick: input.logicalTick },
          effects: [{ type: 'CALL_TOOL', toolName: 'Echo', args: {} }],
        };
      }
      return {
        state: { ...s, logicalTick: input.logicalTick },
        effects: [],
      };
    };

    const inputs = [{ type: 'USER_MESSAGE' as const, content: 'go', logicalTick: 0 }];
    await runLoop(state, trackingStep, ctx, fromArray(inputs));

    // USER_MESSAGE → triggers CALL_TOOL → TOOL_RESULT fed back
    expect(receivedInputs).toHaveLength(2);
    expect(receivedInputs[0]!.type).toBe('USER_MESSAGE');
    expect(receivedInputs[1]!.type).toBe('TOOL_RESULT');
  });

  it('returns final state when external inputs are exhausted', async () => {
    const ctx = makeCtx();
    const state = makeState({ turnCount: 5 });

    const final = await runLoop(state, echoStep, ctx, fromArray([]));

    expect(final.turnCount).toBe(5);
  });
});
