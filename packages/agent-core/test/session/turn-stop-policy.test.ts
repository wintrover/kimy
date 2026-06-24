import { describe, expect, it, vi } from 'vitest';

import { PlanModeTurnStopPolicy } from '#/agent/plan/plan-mode-turn-stop-policy';
import type { Agent } from '#/agent';
import type { TurnStopPolicyContext } from '#/session/turn-stop-policy';

function createMockAgent(planModeActive: boolean) {
  return {
    planMode: {
      isActive: planModeActive,
      exit: vi.fn(),
    },
    context: {
      appendSystemReminder: vi.fn(),
    },
  } as unknown as Agent;
}

function createCtx(
  toolNames: string[] = [],
  stopReason: TurnStopPolicyContext['stopReason'] = 'end_turn',
): TurnStopPolicyContext {
  return {
    stopReason,
    toolCallNames: new Set(toolNames),
  };
}

describe('PlanModeTurnStopPolicy', () => {
  it('has correct name', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);
    expect(policy.name).toBe('plan_mode_guard');
  });

  it('passes through when plan mode is inactive', () => {
    const agent = createMockAgent(false);
    const policy = new PlanModeTurnStopPolicy(agent);

    const result = policy.evaluate(createCtx());

    expect(result).toBeUndefined();
  });

  it('passes through when ExitPlanMode is called', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    const result = policy.evaluate(createCtx(['ExitPlanMode']));

    expect(result).toBeUndefined();
  });

  it('passes through when AskUserQuestion is called', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    const result = policy.evaluate(createCtx(['AskUserQuestion']));

    expect(result).toBeUndefined();
  });

  it('passes through when both ExitPlanMode and other tools are called', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    const result = policy.evaluate(createCtx(['SomeOtherTool', 'ExitPlanMode']));

    expect(result).toBeUndefined();
  });

  it('first failure returns continue with a message', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    const result = policy.evaluate(createCtx());

    expect(result).toEqual({
      continue: true,
      message: expect.stringContaining('ExitPlanMode'),
    });
  });

  it('second consecutive failure forces exit plan mode', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    // First failure — injects reminder.
    policy.evaluate(createCtx());

    // Second failure — forces exit.
    const result = policy.evaluate(createCtx());

    expect(result).toEqual({ continue: false });
    expect(agent.planMode.exit).toHaveBeenCalledTimes(1);
    expect(agent.context.appendSystemReminder).toHaveBeenCalledTimes(1);
    expect(agent.context.appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('automatically exited'),
      { kind: 'system_trigger', name: 'plan_mode_force_exit' },
    );
  });

  it('counter resets after plan mode is deactivated', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    // First failure.
    policy.evaluate(createCtx());

    // Deactivate plan mode — counter should reset.
    (agent.planMode as { isActive: boolean }).isActive = false;
    const resultPassThrough = policy.evaluate(createCtx());

    expect(resultPassThrough).toBeUndefined();
  });

  it('counter resets after valid exit tool call', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    // First failure.
    policy.evaluate(createCtx());

    // Next turn has ExitPlanMode — counter should reset.
    const resultPassThrough = policy.evaluate(createCtx(['ExitPlanMode']));

    expect(resultPassThrough).toBeUndefined();
  });

  it('second failure after two consecutive failures forces exit', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    // First failure — continue.
    const first = policy.evaluate(createCtx());
    expect(first).toEqual({ continue: true, message: expect.any(String) });

    // Second consecutive failure — force exit.
    const second = policy.evaluate(createCtx());
    expect(second).toEqual({ continue: false });
    expect(agent.planMode.exit).toHaveBeenCalledTimes(1);
    expect(agent.context.appendSystemReminder).toHaveBeenCalledTimes(1);

    // After force exit, counter resets — next call is a fresh first failure.
    const third = policy.evaluate(createCtx());
    expect(third).toEqual({ continue: true, message: expect.any(String) });
  });

  it('resets counter and passes through when plan mode toggles off between failures', () => {
    const agent = createMockAgent(true);
    const policy = new PlanModeTurnStopPolicy(agent);

    // First failure.
    policy.evaluate(createCtx());

    // Simulate plan mode toggling off then back on.
    (agent.planMode as { isActive: boolean }).isActive = false;
    const passThrough = policy.evaluate(createCtx());
    expect(passThrough).toBeUndefined();

    // Plan mode back on — should be a fresh first failure, not second.
    (agent.planMode as { isActive: boolean }).isActive = true;
    const freshFirst = policy.evaluate(createCtx());
    expect(freshFirst).toEqual({ continue: true, message: expect.any(String) });

    // Force exit only on the next consecutive failure.
    const forceExit = policy.evaluate(createCtx());
    expect(forceExit).toEqual({ continue: false });
    expect(agent.planMode.exit).toHaveBeenCalledTimes(1);
  });
});
