/**
 * SavePlanTool tests against the current Agent-backed tool surface.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import {
  SavePlanInputSchema,
  SavePlanTool,
} from '../../../src/tools/builtin/planning/save-plan';
import { executeTool } from '../fixtures/execute-tool';

const signal = new AbortController().signal;

function makeAgent(
  input: {
    readonly active?: boolean;
    readonly planFilePath?: string | null;
    readonly plansDir?: string;
    readonly writeText?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const writeText = input.writeText ?? vi.fn().mockResolvedValue(0);
  const agent = {
    planMode: {
      get isActive() { return input.active ?? false; },
      get planFilePath() { return input.planFilePath ?? null; },
      get plansDir() { return input.plansDir ?? '/workspace/plans'; },
      markPlanSaved: vi.fn(),
    },
    kaos: { writeText },
  } as unknown as Agent;
  return { agent, writeText };
}

describe('SavePlanTool', () => {
  it('has name, description, and parameters from the schema', () => {
    const { agent } = makeAgent();
    const tool = new SavePlanTool(agent);

    expect(tool.name).toBe('SavePlan');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain('Save the content of the current plan file');
    expect(tool.description).toContain('plan mode is active');
    expect(SavePlanInputSchema.safeParse({ content: 'test' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        content: expect.any(Object),
      },
    });
  });

  it('saves plan content when plan mode is active', async () => {
    const { agent, writeText } = makeAgent({
      active: true,
      planFilePath: '/workspace/plans/test.md',
      plansDir: '/workspace/plans',
    });

    const result = await executeTool(new SavePlanTool(agent), {
      turnId: '0',
      toolCallId: 'tc_1',
      args: { content: '# My Plan\nSome content' },
      signal,
    });

    expect(writeText).toHaveBeenCalledWith('/workspace/plans/test.md', '# My Plan\nSome content');
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Plan saved');
  });

  it('returns error when plan mode is not active', async () => {
    const { agent } = makeAgent({ active: false, planFilePath: '/workspace/plans/test.md' });

    const result = await executeTool(new SavePlanTool(agent), {
      turnId: '0',
      toolCallId: 'tc_2',
      args: { content: '# My Plan' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('SavePlan can only be used when plan mode is active');
  });

  it('throws when planFilePath is null', async () => {
    const { agent } = makeAgent({ active: true, planFilePath: null });

    const result = await executeTool(new SavePlanTool(agent), {
      turnId: '0',
      toolCallId: 'tc_3',
      args: { content: '# My Plan' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not initialized');
  });

  it('rejects empty content', async () => {
    const { agent, writeText } = makeAgent({
      active: true,
      planFilePath: '/workspace/plans/test.md',
      plansDir: '/workspace/plans',
    });

    const result = await executeTool(new SavePlanTool(agent), {
      turnId: '0',
      toolCallId: 'tc_4',
      args: { content: '' },
      signal,
    });

    expect(writeText).toHaveBeenCalledWith('/workspace/plans/test.md', '');
    expect(result.isError).toBeFalsy();
  });
});
