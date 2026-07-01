/**
 * Virtual-turn interceptor end-to-end tests.
 *
 * When the LLM emits a mixed batch (AgentSwarm + leaf-tool in the same
 * response), the interceptor at the top of `runToolCallBatch` must:
 *   1. Suppress all tool execution.
 *   2. Emit synthetic error tool.result events for every tool call.
 *   3. Return `{ stopTurn: true, virtualTurn: true }`.
 *   4. The `shouldContinueAfterStop` hook (wired by TurnFlow in production,
 *      or by a test hook here) sees `virtualTurn: true`, injects a
 *      correction message, and requests one retry.
 */

import { describe, expect, it } from 'vitest';

import type { ExecutableTool, LoopHooks, ToolExecution, ExecutableToolResult } from '../../src/loop';
import {
  makeEndTurnResponse,
  makeToolCall,
  makeToolUseResponse,
} from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool } from './fixtures/tools';

/* ------------------------------------------------------------------ */
/*  Fixture: a tool named 'AgentSwarm' so the detection fires.        */
/* ------------------------------------------------------------------ */

class AgentSwarmTool implements ExecutableTool {
  readonly name = 'AgentSwarm';
  readonly description = 'Fake swarm tool for testing.';
  readonly parameters = { type: 'object', properties: {}, additionalProperties: true };

  readonly calls: string[] = [];

  validateArgs(args: unknown) {
    return { success: true as const, data: args };
  }

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push(ctx.toolCallId);
        return { output: 'subagent done' };
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: build a shouldContinueAfterStop hook that handles the      */
/*  virtual-turn retry exactly like TurnFlow does.                     */
/* ------------------------------------------------------------------ */

function createVirtualTurnHook(): {
  hook: NonNullable<LoopHooks['shouldContinueAfterStop']>;
  virtualTurnRetryCount: { value: number };
} {
  const state = { value: 0 };
  const hook: NonNullable<LoopHooks['shouldContinueAfterStop']> = async (ctx) => {
    if (ctx.virtualTurn === true) {
      state.value += 1;
      if (state.value <= 1) {
        return { continue: true };
      }
    }
    return { continue: false };
  };
  return { hook, virtualTurnRetryCount: state };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('runTurn — virtual-turn interceptor', () => {
  it('suppresses execution and emits error results for a mixed AgentSwarm + leaf batch', async () => {
    const swarm = new AgentSwarmTool();
    const echo = new EchoTool();
    const { hook } = createVirtualTurnHook();

    const { context, llm, result } = await runTurn({
      tools: [swarm, echo],
      hooks: { shouldContinueAfterStop: hook },
      responses: [
        // Step 1: mixed batch — AgentSwarm + echo in the same response
        makeToolUseResponse([
          makeToolCall('AgentSwarm', { prompt: 'do stuff' }, 'tc-swarm'),
          makeToolCall('echo', { text: 'hi' }, 'tc-echo'),
        ]),
        // Step 2: after the virtual-turn correction, the LLM responds normally
        makeEndTurnResponse('corrected'),
      ],
    });

    // Neither tool should have been actually executed
    expect(swarm.calls.length).toBe(0);
    expect(echo.calls.length).toBe(0);

    // Both tool calls should have paired call + result events
    const toolCalls = context.toolCalls();
    const toolResults = context.toolResults();
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);

    // Both results should be error results with the correction message
    for (const tr of toolResults) {
      expect(tr.result.isError).toBe(true);
      expect(String(tr.result.output)).toContain('AgentSwarm must be the only tool call');
    }

    // Tool call IDs should match
    expect(toolCalls.map((tc) => tc.toolCallId).sort()).toEqual(
      toolResults.map((tr) => tr.toolCallId).sort(),
    );

    // The turn should have used 2 LLM steps (mixed batch + corrected response)
    expect(llm.callCount).toBe(2);
    expect(result.steps).toBe(2);
  });

  it('does not intercept a batch that contains only AgentSwarm', async () => {
    const swarm = new AgentSwarmTool();

    const { llm } = await runTurn({
      tools: [swarm],
      responses: [
        makeToolUseResponse([
          makeToolCall('AgentSwarm', { prompt: 'do stuff' }, 'tc-swarm'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    // AgentSwarm should have been executed normally
    expect(swarm.calls.length).toBe(1);
    expect(swarm.calls[0]).toBe('tc-swarm');
    expect(llm.callCount).toBe(2);
  });

  it('does not intercept a batch that contains no AgentSwarm', async () => {
    const echo = new EchoTool();

    const { llm } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'hello' }, 'tc-1'),
          makeToolCall('echo', { text: 'world' }, 'tc-2'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });

    // Both echo calls should have been executed
    expect(echo.calls.length).toBe(2);
    expect(llm.callCount).toBe(2);
  });

  it('allows exactly one virtual-turn retry, then stops on second virtual turn', async () => {
    const swarm = new AgentSwarmTool();
    const echo = new EchoTool();
    const { hook, virtualTurnRetryCount } = createVirtualTurnHook();

    const { llm, context, result } = await runTurn({
      tools: [swarm, echo],
      hooks: { shouldContinueAfterStop: hook },
      responses: [
        // Step 1: mixed batch
        makeToolUseResponse([
          makeToolCall('AgentSwarm', { prompt: 'first' }, 'tc-1'),
          makeToolCall('echo', { text: 'a' }, 'tc-2'),
        ]),
        // Step 2: still a mixed batch after correction — hook sees
        // virtualTurnRetryCount === 1, so returns { continue: false }
        makeToolUseResponse([
          makeToolCall('AgentSwarm', { prompt: 'second' }, 'tc-3'),
          makeToolCall('echo', { text: 'b' }, 'tc-4'),
        ]),
      ],
    });

    // Neither tool was ever actually executed
    expect(swarm.calls.length).toBe(0);
    expect(echo.calls.length).toBe(0);

    // The hook was asked to retry exactly once, then denied the second
    expect(virtualTurnRetryCount.value).toBe(2);

    // We should have 4 tool result events (2 per mixed batch)
    const toolResults = context.toolResults();
    expect(toolResults.length).toBe(4);
    for (const tr of toolResults) {
      expect(tr.result.isError).toBe(true);
    }

    // 2 LLM calls: mixed, then mixed again (but the turn stops after the
    // second virtual turn since the hook returns { continue: false })
    expect(llm.callCount).toBe(2);
    expect(result.steps).toBe(2);
  });

  it('without a shouldContinueAfterStop hook the turn ends after the virtual turn', async () => {
    const swarm = new AgentSwarmTool();
    const echo = new EchoTool();

    const { llm, context, result } = await runTurn({
      tools: [swarm, echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('AgentSwarm', { prompt: 'x' }, 'tc-1'),
          makeToolCall('echo', { text: 'y' }, 'tc-2'),
        ]),
        // This response is never consumed because the turn stops
        makeEndTurnResponse('unused'),
      ],
    });

    // Neither tool executed
    expect(swarm.calls.length).toBe(0);
    expect(echo.calls.length).toBe(0);

    // Error results still emitted
    const toolResults = context.toolResults();
    expect(toolResults.length).toBe(2);
    for (const tr of toolResults) {
      expect(tr.result.isError).toBe(true);
    }

    // Only 1 LLM call — the turn stopped after the intercepted batch
    expect(llm.callCount).toBe(1);
    expect(result.steps).toBe(1);
  });
});
