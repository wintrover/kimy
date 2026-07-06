import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { PlanMode, PlanTransition, PlanTransitionState } from '../../src/agent/plan';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';

function createPlanKaos(overrides: Parameters<typeof createFakeKaos>[0] = {}) {
  return createFakeKaos({
    mkdir: vi.fn().mockResolvedValue(undefined),
    iterdir: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    stat: vi.fn().mockResolvedValue({ stMtime: Date.now() / 1000, stMode: 0o040755 } as any),
    ...overrides,
  });
}

describe('manual plan entry', () => {
  it('keeps permission gating out of the PlanMode state object', () => {
    const ctx = testAgent();

    expect('beforeToolCall' in ctx.agent.planMode).toBe(false);
  });

  it('enters plan mode without starting a model turn and prepares the plan directory', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(0);
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {
      // empty plans directory
    });
    const stat = vi.fn().mockResolvedValue({ stMtime: Date.now() / 1000, stMode: 0o040755 } as any);
    const ctx = testAgent({
      kaos: createFakeKaos({ mkdir, writeText, iterdir, stat }),
    });

    await ctx.rpc.enterPlan({});
    await delay(10);

    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.agent.planMode.planFilePath).toMatch(/\.md$/);
    expect(mkdir).toHaveBeenCalledWith('/workspace/plans', { parents: true, existOk: true });
    expect(writeText).not.toHaveBeenCalled();
    expect(ctx.allEvents.some((event) => event.event === 'turn.started')).toBe(false);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('derives the no-homedir plan path from cwd on enter and restore', async () => {
    const ctx = testAgent({
      kaos: createPlanKaos({
        writeText: vi.fn(async (_path: string, content: string) => content.length),
      }),
    });
    await ctx.agent.planMode.enter('stable-plan');

    const livePath = ctx.agent.planMode.planFilePath;
    if (livePath === null) throw new Error('expected active plan path');
    expect(livePath).toBe('/workspace/plans/stable-plan.md');

    const enterRecord = ctx.allEvents.find(
      (event) => event.type === '[wire]' && event.event === 'plan_mode.enter',
    );
    expect(enterRecord?.args).toEqual({
      id: 'stable-plan',
      time: expect.any(Number),
    });

    const resumed = testAgent({ kaos: createFakeKaos() });
    resumed.dispatch({
      type: 'plan_mode.enter',
      id: 'stable-plan',
    });

    expect(resumed.agent.planMode.planFilePath).toBe(livePath);
  });

  it('enters plan mode through the EnterPlanMode tool and reminds the next step', async () => {
    const enterPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_enter_plan',
      name: 'EnterPlanMode',
      arguments: '{}',
    };
    const ctx = testAgent({
      kaos: createPlanKaos({
        writeText: vi.fn(async (_path: string, content: string) => content.length),
        iterdir: vi.fn(async function* (): AsyncGenerator<string> {
          // empty plans directory
        }),
      }),
    });
    ctx.configure({ tools: ['EnterPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'I will enter plan mode.' }, enterPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'Plan mode is active now.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Plan first' }] });

    await ctx.untilTurnEnd();
    await delay(10);
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.llmCalls).toHaveLength(2);
    expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('Plan mode is now active');
    await ctx.expectResumeMatches();
  });
});

describe('plan clear', () => {
  it('empties the current plan file without leaving plan mode', async () => {
    const files = new Map<string, string>();
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const writeText = vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return content.length;
    });

    const ctx = testAgent({
      kaos: createPlanKaos({ mkdir, readText, writeText }),
    });
    await ctx.agent.planMode.enter('test-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Step 1');

    await ctx.rpc.clearPlan({});

    expect(writeText).toHaveBeenCalledWith(planPath, '');
    expect(files.get(planPath)).toBe('');
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.agent.planMode.planFilePath).toBe(planPath);
    await expect(ctx.rpc.getPlan({})).resolves.toMatchObject({
      id: 'test-plan',
      content: '',
      path: planPath,
    });
    await ctx.expectResumeMatches();
  });
});

describe('plan exit tool', () => {
  it('reads the current plan file and exits plan mode directly in auto mode', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.agent.planMode.enter('test-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_plan',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    await ctx.untilTurnEnd();
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
    ).toBe(false);
    expect(readText).toHaveBeenCalledWith(planPath);
    expect(ctx.agent.planMode.isActive).toBe(false);
    const llmInput = ctx.llmCalls[1]!;
    expect(toolResultText(llmInput.history)).toContain('Plan mode deactivated');
    expect(toolResultText(llmInput.history)).toContain('# Plan');
    await ctx.expectResumeMatches();
  });

  it('stops the turn and stays in plan mode when the user rejects the plan', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'manual' });
    await ctx.agent.planMode.enter('reject-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_reject',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'This response must not be requested.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'rejected', selectedLabel: 'Reject' });

    await ctx.untilTurnEnd();
    expect(readText).toHaveBeenCalledWith(planPath);
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(toolResultText(ctx.agent.context.history)).toContain('Plan rejected by user');
    await ctx.expectResumeMatches();
  });

  it('does not execute later tool calls in the same batch after plan rejection', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const execWithEnv = vi.fn(() => {
      throw new Error('Bash should not execute after plan rejection');
    });
    const ctx = testAgent({
      kaos: createPlanKaos({ readText, execWithEnv }),
    });
    ctx.configure({ tools: ['ExitPlanMode', 'Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('reject-and-exit-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_reject_and_exit',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash_after_reject',
      name: 'Bash',
      arguments: '{"command":"touch should-not-run","timeout":60}',
    };
    ctx.mockNextResponse(
      { type: 'text', text: 'I will present the plan and then run a command.' },
      exitPlanModeCall,
      bashCall,
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'rejected', selectedLabel: 'Reject' });

    await ctx.untilTurnEnd();
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(ctx.llmCalls).toHaveLength(1);
    expect(toolResultText(ctx.agent.context.history)).toContain('Plan rejected by user');
    expect(toolResultText(ctx.agent.context.history)).toContain(
      'Tool skipped because a previous tool call stopped the turn.',
    );
    await ctx.expectResumeMatches();
  });

  it('refuses to exit when the current plan file is empty', async () => {
    const readText = vi.fn(async () => '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('empty-plan', false);

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_empty_plan',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    ctx.mockNextResponse(
      { type: 'text', text: 'I will present the empty plan.' },
      exitPlanModeCall,
    );
    ctx.mockNextResponse({ type: 'text', text: 'I need to write the plan first.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show an empty plan' }] });

    await ctx.untilTurnEnd();
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('No plan file found');
    await ctx.expectResumeMatches();
  });
});

describe('plan exit tool options', () => {
  it('keeps options for approval when an option omits the optional description', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'manual' });
    await ctx.agent.planMode.enter('options-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_options',
      name: 'ExitPlanMode',
        // The second option omits `description` — valid input after the
        // schema relaxation. The approval policy must still surface both.
        arguments: JSON.stringify({
          options: [
            { label: 'Approach A', description: 'Smaller refactor.' },
            { label: 'Approach B' },
          ],
        }),
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    const approval = await ctx.takeApprovalRequest();
    const rpcArgs = (
      ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'requestApproval',
      ) as { args: { action?: string; display?: { options?: readonly unknown[] } } } | undefined
    )?.args;

    expect(rpcArgs?.action).toBe('Presenting plan and exiting plan mode');
    expect(rpcArgs?.display?.options).toHaveLength(2);

    approval.respond({ decision: 'approved', selectedLabel: 'Approach A' });
    await ctx.untilTurnEnd();
  });
});

describe('plan allows safe tool flow', () => {
  it.each(['Write', 'Edit'] as const)(
    'runs %s on the active plan file without approval in manual mode',
    async (toolName) => {
      const files = new Map<string, string>();
      const readText = vi.fn(async (path: string) => files.get(path) ?? '');
      const writeText = vi.fn(async (path: string, content: string) => {
        files.set(path, content);
        return content.length;
      });
      const ctx = testAgent({
        kaos: createPlanKaos({ readText, writeText }),
      });
      ctx.configure({ tools: [toolName] });
      await ctx.agent.planMode.enter('test-plan', false);

      const planPath = ctx.agent.planMode.planFilePath;
      if (planPath === null) throw new Error('expected active plan path');
      files.set(planPath, '# Plan\n\n- Draft');

      const expectedContent =
        toolName === 'Write' ? '# Plan\n\n- Inspect\n- Verify' : '# Plan\n\n- Draft\n- Verify';
      const args =
        toolName === 'Write'
          ? { path: planPath, content: expectedContent }
          : { path: planPath, old_string: '- Draft', new_string: '- Draft\n- Verify' };
      const writePlanCall: ToolCall = {
        type: 'function',
        id: `call_${toolName.toLowerCase()}_plan`,
        name: toolName,
          arguments: JSON.stringify(args),
      };

      ctx.mockNextResponse({ type: 'text', text: 'I will update the plan file.' }, writePlanCall);
      ctx.mockNextResponse({ type: 'text', text: 'Plan file updated.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Update the plan file' }] });

      await ctx.untilTurnEnd();

      expect(files.get(planPath)).toBe(expectedContent);
      expect(writeText).toHaveBeenCalledWith(planPath, expectedContent);
      expect(
        ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
      ).toBe(false);
      await ctx.expectResumeMatches();
    },
  );

  it('keeps explicit deny rules above active plan file writes', async () => {
    const files = new Map<string, string>();
    const writeText = vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return content.length;
    });
    const ctx = testAgent({
      kaos: createPlanKaos({ writeText }),
    });
    ctx.configure({ tools: ['Write'] });
    ctx.agent.permission.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Write',
      reason: 'blocked by test',
    });
    await ctx.agent.planMode.enter('test-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    const content = '# Plan\n\n- Inspect\n- Verify';
    const writePlanCall: ToolCall = {
      type: 'function',
      id: 'call_write_plan_with_deny',
      name: 'Write',
      arguments: JSON.stringify({ path: planPath, content }),
    };

    ctx.mockNextResponse({ type: 'text', text: 'I will update the plan file.' }, writePlanCall);
    ctx.mockNextResponse({ type: 'text', text: 'Plan file updated.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Update the plan file' }] });

    await ctx.untilTurnEnd();

    expect(files.get(planPath)).toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
    expect(toolResultText(ctx.agent.context.history)).toContain(
      'Tool "Write" was denied by permission rule. Reason: blocked by test',
    );
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
    ).toBe(false);
  });

  it('allows read-only Bash to continue through permission and execution', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf plan-safe","timeout":60}',
    };
    const ctx = testAgent({ kaos: createCommandKaos('plan-safe') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('test-plan', false);

    ctx.mockNextResponse({ type: 'text', text: 'I will inspect safely.' }, bashCall);
    ctx.mockNextResponse({ type: 'text', text: 'The safe command printed plan-safe.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Inspect without mutating files' }] });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "yolo" }
      [wire] plan_mode.enter             { "id": "test-plan", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": true, "swarmMode": false, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will inspect safely." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will inspect safely." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "plan-safe" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "plan-safe" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "plan-safe" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 536, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 536, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 536, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 559, "maxContextTokens": 1000000, "contextUsage": 0.000559, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 536, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 536, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 536, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The safe command printed plan-safe." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The safe command printed plan-safe." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 563, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 563, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 563, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 575, "maxContextTokens": 1000000, "contextUsage": 0.000575, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 1099, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1099, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1099, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    await ctx.expectResumeMatches();
  });
});

describe('plan mode Bash ordinary permission behavior', () => {
  it('allows Bash through ordinary yolo permission behavior', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"rm forbidden.txt","timeout":60}',
    };
    const ctx = testAgent({ kaos: createCommandKaos('removed') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('test-plan', false);

    ctx.mockNextResponse({ type: 'text', text: 'I will mutate a file.' }, bashCall);
    ctx.mockNextResponse({ type: 'text', text: 'The command completed.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Remove forbidden.txt' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "yolo" }
      [wire] plan_mode.enter             { "id": "test-plan", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": true, "swarmMode": false, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will mutate a file." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will mutate a file." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "removed" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "removed" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "removed" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 533, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 533, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 533, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 556, "maxContextTokens": 1000000, "contextUsage": 0.000556, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 533, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 533, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 533, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command completed." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command completed." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 559, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 559, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 559, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 568, "maxContextTokens": 1000000, "contextUsage": 0.000568, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 1092, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1092, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1092, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(toolResultText(ctx.agent.context.history)).toContain('removed');
    await ctx.expectResumeMatches();
  });
});

describe('plan mode injection cadence', () => {
  it('dedupes immediate repeats and emits sparse reminders after assistant turns', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.planMode.enter('test-plan', false);

    await ctx.agent.injection.inject();
    const afterFull = ctx.agent.context.history.length;
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode is active');
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan file:');

    await ctx.agent.injection.inject();
    expect(ctx.agent.context.history).toHaveLength(afterFull);

    ctx.appendAssistantTurn(1, 'assistant one');
    ctx.appendAssistantTurn(2, 'assistant two');
    await ctx.agent.injection.inject();

    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode still active');
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan file:');
    await ctx.expectResumeMatches();
  });

  it('emits a reentry reminder when restored plan mode already has plan content', async () => {
    const ctx = testAgent({
      kaos: createFakeKaos({
        readText: vi.fn(async () => '# Existing Plan\n\n- Keep this context'),
      }),
    });
    ctx.configure();
    ctx.dispatch({
      type: 'plan_mode.enter',
      id: 'restored-plan',
    });

    await ctx.agent.injection.inject();

    expect(lastUserText(ctx.agent.context.history)).toContain('Re-entering Plan Mode');
    expect(lastUserText(ctx.agent.context.history)).toContain('Read the existing plan file');
    await ctx.expectResumeMatches();
  });

  it('emits one exit reminder after leaving plan mode', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.planMode.enter('test-plan', false);
    await ctx.agent.injection.inject();

    ctx.agent.planMode.exit();
    await ctx.agent.injection.inject();
    const afterExit = ctx.agent.context.history.length;
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode is no longer active');

    await ctx.agent.injection.inject();
    expect(ctx.agent.context.history).toHaveLength(afterExit);
    await ctx.expectResumeMatches();
  });

  it('keeps the preserved injection index aligned after undo removes earlier messages', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.planMode.enter('test-plan', false);

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'draft the plan' }]);
    await ctx.agent.injection.inject();
    ctx.appendAssistantTurn(1, 'Plan drafted.');

    ctx.agent.context.undo(1);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'new plan request' }]);
    await ctx.agent.injection.inject();

    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode is active');
  });
});

describe('plan GC', () => {
  const plansDir = '/workspace/plans';
  const ONE_DAY_S = 24 * 60 * 60;

  it('runs GC when timestamp file is older than 7 days', async () => {
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {});
    const stat = vi.fn().mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.endsWith('.last-gc-check')) {
        return { stMtime: Date.now() / 1000 - 8 * ONE_DAY_S, stMode: 0o040755 } as any;
      }
      return { stMtime: Date.now() / 1000, stMode: 0o040755 } as any;
    });
    const ctx = testAgent({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        iterdir,
        stat,
      }),
    });
    await ctx.agent.planMode.enter('gc-test-old', false);
    expect(iterdir).toHaveBeenCalledWith(plansDir);
  });

  it('skips GC when timestamp file is recent', async () => {
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {});
    const stat = vi.fn().mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.endsWith('.last-gc-check')) {
        return { stMtime: Date.now() / 1000 - ONE_DAY_S, stMode: 0o040755 } as any;
      }
      return { stMtime: Date.now() / 1000, stMode: 0o040755 } as any;
    });
    const ctx = testAgent({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        iterdir,
        stat,
      }),
    });
    await ctx.agent.planMode.enter('gc-test-recent', false);
    expect(iterdir).not.toHaveBeenCalled();
  });

  it('runs GC on first encounter when timestamp file does not exist', async () => {
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {});
    const stat = vi.fn().mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.endsWith('.last-gc-check')) {
        const err = new Error('ENOENT');
        (err as any).code = 'ENOENT';
        throw err;
      }
      return { stMtime: Date.now() / 1000, stMode: 0o040755 } as any;
    });
    const ctx = testAgent({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        iterdir,
        stat,
      }),
    });
    await ctx.agent.planMode.enter('gc-test-first', false);
    expect(iterdir).toHaveBeenCalledWith(plansDir);
  });

  it('forces GC on corrupted timestamp file and logs a warning', async () => {
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {});
    const stat = vi.fn().mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.endsWith('.last-gc-check')) {
        const err = new Error('EACCES');
        (err as any).code = 'EACCES';
        throw err;
      }
      return { stMtime: Date.now() / 1000, stMode: 0o040755 } as any;
    });
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = testAgent({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        iterdir,
        stat,
      }),
      log,
    });
    await ctx.agent.planMode.enter('gc-test-corrupt', false);
    expect(iterdir).toHaveBeenCalledWith(plansDir);
    expect(log.warn).toHaveBeenCalledWith(
      'PlanMode: GC timestamp file unreadable, forcing GC',
      expect.objectContaining({ error: expect.objectContaining({ code: 'EACCES' }) }),
    );
  });
});

describe('plan write retry', () => {
  const plansDir = '/workspace/plans';

  it('retries on collision and succeeds on the second attempt', async () => {
    let statCallCount = 0;
    const stat = vi.fn().mockImplementation(async () => {
      statCallCount++;
      if (statCallCount === 1) {
        return { stMtime: Date.now() / 1000, stMode: 0o040755 } as any;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const writeText = vi.fn().mockResolvedValue(0);
    const ctx = testAgent({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        iterdir: vi.fn(async function* (): AsyncGenerator<string> {}),
        stat,
        writeText,
      }),
    });
    const result = await (ctx.agent.planMode as any).writePlanWithRetry('plan content');
    expect(result).toMatchObject({ id: expect.any(String), path: expect.stringContaining(plansDir) });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('throws when max retries are exceeded', async () => {
    const stat = vi.fn().mockResolvedValue({ stMtime: Date.now() / 1000, stMode: 0o040755 } as any);
    const ctx = testAgent({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        iterdir: vi.fn(async function* (): AsyncGenerator<string> {}),
        stat,
        writeText: vi.fn().mockResolvedValue(0),
      }),
    });
    await expect((ctx.agent.planMode as any).writePlanWithRetry('plan content')).rejects.toThrow(
      'too many collisions',
    );
  });
});

describe('plan transition state machine', () => {
  describe('transitionState lifecycle', () => {
    it('starts in idle state', () => {
      const ctx = testAgent();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('markPlanSaved transitions to plan_saved', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test-source');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);
    });

    it('clearTransitionState resets to idle', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test-source');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      ctx.agent.planMode.clearTransitionState(PlanTransition.PLAN_SAVED_TO_IDLE, 'test-clear');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('incrementResumeAttempts increments and returns the count', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test-source');

      expect(ctx.agent.planMode.incrementResumeAttempts()).toBe(1);
      expect(ctx.agent.planMode.incrementResumeAttempts()).toBe(2);
      expect(ctx.agent.planMode.incrementResumeAttempts()).toBe(3);
    });

    it('MAX_PLAN_RESUME_ATTEMPTS is 2', () => {
      expect(PlanMode.MAX_PLAN_RESUME_ATTEMPTS).toBe(2);
    });

    it('markPlanSaved resets resume attempts to 0', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test-source');

      ctx.agent.planMode.incrementResumeAttempts();
      ctx.agent.planMode.incrementResumeAttempts();
      // markPlanSaved resets attempts
      ctx.agent.planMode.markPlanSaved('test-source-again');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);
      // After reset, first increment should return 1
      expect(ctx.agent.planMode.incrementResumeAttempts()).toBe(1);
    });

    it('clearTransitionState resets resume attempts to 0', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test-source');

      ctx.agent.planMode.incrementResumeAttempts();
      ctx.agent.planMode.incrementResumeAttempts();
      ctx.agent.planMode.clearTransitionState(PlanTransition.PLAN_SAVED_TO_IDLE, 'test');
      // After clear, first increment should return 1
      expect(ctx.agent.planMode.incrementResumeAttempts()).toBe(1);
    });
  });

  describe('SavePlan → plan_saved', () => {
    it('sets transitionState to plan_saved after successful save', async () => {
      const files = new Map<string, string>();
      const writeText = vi.fn(async (path: string, content: string) => {
        files.set(path, content);
        return content.length;
      });
      const ctx = testAgent({
        kaos: createPlanKaos({ writeText }),
      });
      ctx.configure({ tools: ['SavePlan'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await ctx.agent.planMode.enter('transition-save', false);

      const planPath = ctx.agent.planMode.planFilePath;
      if (planPath === null) throw new Error('expected active plan path');

      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);

      const savePlanCall: ToolCall = {
        type: 'function',
        id: 'call_save_plan',
        name: 'SavePlan',
        arguments: JSON.stringify({ content: '# Plan\n\n- Step 1\n- Step 2' }),
      };
      ctx.mockNextResponse(
        { type: 'text', text: 'I will save the plan.' },
        savePlanCall,
      );
      ctx.mockNextResponse({ type: 'text', text: 'Plan saved successfully.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Save my plan' }] });

      await ctx.untilTurnEnd();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);
      expect(files.get(planPath)).toBe('# Plan\n\n- Step 1\n- Step 2');
      await ctx.expectResumeMatches();
    });
  });

  describe('ExitPlanMode → idle', () => {
    it('clears transitionState on successful exit', async () => {
      const files = new Map<string, string>();
      const readText = vi.fn(async (path: string) => files.get(path) ?? '');
      const ctx = testAgent({
        kaos: createPlanKaos({ readText }),
      });
      ctx.configure({ tools: ['ExitPlanMode'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.agent.planMode.enter('transition-exit', false);

      const planPath = ctx.agent.planMode.planFilePath;
      if (planPath === null) throw new Error('expected active plan path');
      files.set(planPath, '# Plan\n\n- Step 1');

      // Manually mark plan as saved to set transition state
      ctx.agent.planMode.markPlanSaved('test-setup');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_plan',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'I will exit plan mode.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'Plan mode exited.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Exit plan mode' }] });

      await ctx.untilTurnEnd();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
      expect(ctx.agent.planMode.isActive).toBe(false);
      await ctx.expectResumeMatches();
    });

    it('surfaces readText error as tool result without resetting transitionState', async () => {
      const readText = vi.fn(async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      });
      const ctx = testAgent({
        kaos: createPlanKaos({ readText }),
      });
      ctx.configure({ tools: ['ExitPlanMode'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await ctx.agent.planMode.enter('transition-error', false);

      // Manually mark plan as saved
      ctx.agent.planMode.markPlanSaved('test-setup');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_error',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse(
        { type: 'text', text: 'I will exit plan mode.' },
        exitPlanModeCall,
      );
      ctx.mockNextResponse({ type: 'text', text: 'Something went wrong.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Exit plan mode' }] });

      await ctx.untilTurnEnd();
      // resolvePlan() catches readText error internally and returns a tool error,
      // so the outer safety catch never fires; transitionState remains plan_saved
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);
      // Plan mode should still be active (exit failed)
      expect(ctx.agent.planMode.isActive).toBe(true);
      // The error should be surfaced in the tool result
      expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('Failed to read plan file');
      await ctx.expectResumeMatches();
    });
  });

  describe('shouldContinueAfterStop plan invariant', () => {
    it('micro-resumes when model ends turn with plan_saved and stopReason end_turn', async () => {
      const files = new Map<string, string>();
      const readText = vi.fn(async (path: string) => files.get(path) ?? '');
      const ctx = testAgent({
        kaos: createPlanKaos({ readText }),
      });
      ctx.configure({ tools: ['ExitPlanMode'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.agent.planMode.enter('resume-test', false);

      const planPath = ctx.agent.planMode.planFilePath;
      if (planPath === null) throw new Error('expected active plan path');
      files.set(planPath, '# Plan\n\n- Step 1');

      // Manually mark plan as saved to simulate SavePlan having been called
      ctx.agent.planMode.markPlanSaved('test-setup');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      // Mock LLM response 1: text + end_turn (model "forgets" ExitPlanMode)
      // shouldContinueAfterStop should detect plan_saved and continue
      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_resume',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'Plan looks good.' });
      // Mock LLM response 2: ExitPlanMode tool call (micro-resume worked)
      ctx.mockNextResponse({ type: 'text', text: 'Exiting now.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'Done.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Review the plan' }] });

      await ctx.untilTurnEnd();
      // The model should have been called at least twice (original + micro-resume)
      expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(2);
      // After ExitPlanMode, transitionState should be idle
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
      expect(ctx.agent.planMode.isActive).toBe(false);
      await ctx.expectResumeMatches();
    });

    it('force-resets after MAX_PLAN_RESUME_ATTEMPTS exceeded', async () => {
      const ctx = testAgent();
      ctx.configure();
      await ctx.agent.planMode.enter('max-attempts-test', false);

      // Manually mark plan as saved
      ctx.agent.planMode.markPlanSaved('test-setup');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      // Mock 3 LLM responses, all text + end_turn (model never calls ExitPlanMode)
      // Attempt 1: 1 > 2? No → continue
      // Attempt 2: 2 > 2? No → continue
      // Attempt 3: 3 > 2? Yes → force reset, stop
      ctx.mockNextResponse({ type: 'text', text: 'Response 1.' });
      ctx.mockNextResponse({ type: 'text', text: 'Response 2.' });
      ctx.mockNextResponse({ type: 'text', text: 'Response 3.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Review plan' }] });

      await ctx.untilTurnEnd();
      // All 3 LLM calls should have been made
      expect(ctx.llmCalls).toHaveLength(3);
      // After max attempts, transitionState should be force-reset to idle
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
      // Plan mode should still be active (only the transition state was reset)
      expect(ctx.agent.planMode.isActive).toBe(true);
      await ctx.expectResumeMatches();
    });
  });

  describe('beforeStep forceToolChoice', () => {
    it('returns forceToolChoice when transitionState is plan_saved', async () => {
      const files = new Map<string, string>();
      const readText = vi.fn(async (path: string) => files.get(path) ?? '');
      const ctx = testAgent({
        kaos: createPlanKaos({ readText }),
      });
      ctx.configure({ tools: ['ExitPlanMode'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.agent.planMode.enter('force-tool-choice', false);

      const planPath = ctx.agent.planMode.planFilePath;
      if (planPath === null) throw new Error('expected active plan path');
      files.set(planPath, '# Plan\n\n- Step 1');

      // Mark plan as saved so beforeStep returns forceToolChoice
      ctx.agent.planMode.markPlanSaved('test-setup');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      // The model is "forced" to call ExitPlanMode by the beforeStep hook
      const exitPlanModeCall: ToolCall = {
        type: 'function',
        id: 'call_exit_forced',
        name: 'ExitPlanMode',
        arguments: '{}',
      };
      ctx.mockNextResponse({ type: 'text', text: 'Exiting plan mode.' }, exitPlanModeCall);
      ctx.mockNextResponse({ type: 'text', text: 'Done.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Finish plan' }] });

      await ctx.untilTurnEnd();
      // ExitPlanMode should have been called
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
      expect(ctx.agent.planMode.isActive).toBe(false);
      await ctx.expectResumeMatches();
    });

    it('does not set forceToolChoice when transitionState is idle', async () => {
      const ctx = testAgent();
      ctx.configure();
      await ctx.agent.planMode.enter('no-force-tool-choice', false);

      // transitionState should be idle
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);

      // Model returns normal text + end_turn, no forceToolChoice干预
      ctx.mockNextResponse({ type: 'text', text: 'Normal response.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

      await ctx.untilTurnEnd();
      // Only 1 LLM call (no micro-resume since state is idle)
      expect(ctx.llmCalls).toHaveLength(1);
      // transitionState should still be idle
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
      await ctx.expectResumeMatches();
    });
  });

  describe('exit() transitionState invariant', () => {
    it('exit() clears transitionState when plan_saved', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      ctx.agent.planMode.exit();

      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('exit() is idempotent', () => {
      const ctx = testAgent();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);

      expect(() => ctx.agent.planMode.exit()).not.toThrow();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);

      expect(() => ctx.agent.planMode.exit()).not.toThrow();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('exit() clears transitionState even when logRecord throws', () => {
      const ctx = testAgent();
      vi.spyOn(ctx.agent.records, 'logRecord').mockImplementation(() => {
        throw new Error('logRecord boom');
      });
      ctx.agent.planMode.markPlanSaved('test');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      // logRecord throws and exit() propagates the error, but the finally block
      // still enforces the invariant — state is cleared regardless
      try {
        ctx.agent.planMode.exit();
      } catch {
        // expected — logRecord error propagates from the try block
      }
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('exit() clears transitionState even when emitTransition throws', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      // Mock log.info to throw so that emitTransition (called from clearTransitionState)
      // throws during the finally block — set up AFTER markPlanSaved to avoid breaking it
      const originalLog = ctx.agent.log;
      let logInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
      if (originalLog !== null && originalLog !== undefined && typeof originalLog === 'object' && 'info' in originalLog) {
        logInfoSpy = vi.spyOn(originalLog as { info: (...args: unknown[]) => void }, 'info').mockImplementation(() => {
          throw new Error('emitTransition boom');
        });
      }

      try {
        ctx.agent.planMode.exit();
      } finally {
        logInfoSpy?.mockRestore();
      }

      // emitTransition throws inside clearTransitionState, but the inner try-catch
      // in exit()'s finally block catches it and directly assigns IDLE
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('shouldContinueAfterStop does not fire micro-resume after exit()', () => {
      const ctx = testAgent();
      ctx.agent.planMode.markPlanSaved('test');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);

      ctx.agent.planMode.exit();
      // After exit(), transitionState must be IDLE, which means the
      // shouldContinueAfterStop hook (which checks for PLAN_SAVED) will not fire
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
      expect(ctx.agent.planMode.isActive).toBe(false);
    });

    it('cancel() clears transitionState when plan_saved', () => {
      const ctx = testAgent();
      ctx.agent.planMode.enter();
      ctx.agent.planMode.markPlanSaved('test');
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.PLAN_SAVED);
      ctx.agent.planMode.cancel();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });

    it('cancel() is idempotent when transitionState already idle', () => {
      const ctx = testAgent();
      ctx.agent.planMode.enter();
      ctx.agent.planMode.cancel();
      expect(() => ctx.agent.planMode.cancel()).not.toThrow();
      expect(ctx.agent.planMode.transitionState).toBe(PlanTransitionState.IDLE);
    });
  });
});

describe('enter() post-await guard', () => {
  it('skips logRecord when exit() called during ensurePlanDirectory', async () => {
    let resolveMkdir: (value: void) => void;
    const mkdirPromise = new Promise<void>((resolve) => {
      resolveMkdir = resolve;
    });

    const kaos = createPlanKaos({
      mkdir: vi.fn().mockReturnValue(mkdirPromise),
    });
    const ctx = testAgent({ kaos });

    // enter() starts — pauses at ensurePlanDirectory
    const enterPromise = ctx.agent.planMode.enter('test-plan', false, false);

    // drain microtask queue, then call exit()
    await new Promise((r) => setTimeout(r, 0));
    ctx.agent.planMode.exit();

    // complete mkdir
    resolveMkdir!();
    await enterPromise;

    // enter() should have returned early → plan mode inactive
    expect(ctx.agent.planMode.isActive).toBe(false);
  });

  it('stops after mkdir when exit() called before writeEmptyPlanFile', async () => {
    let resolveWrite: (value: void) => void;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });

    const kaos = createPlanKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockReturnValue(writePromise),
    });
    const ctx = testAgent({ kaos });

    // createFile=true to trigger writeEmptyPlanFile
    const enterPromise = ctx.agent.planMode.enter('test-plan', true, false);

    // ensurePlanDirectory completes, then pause at writeEmptyPlanFile → exit()
    await new Promise((r) => setTimeout(r, 0));
    ctx.agent.planMode.exit();

    // complete write
    resolveWrite!();
    await enterPromise;

    expect(ctx.agent.planMode.isActive).toBe(false);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  const message = history.findLast((item) => item.role === 'user');
  if (message === undefined) return '';
  return message.content
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

function toolResultText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  return history
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content)
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n');
}
