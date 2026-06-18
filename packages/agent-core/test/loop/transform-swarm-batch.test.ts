import { describe, expect, it } from 'vitest';

import type { ExecutableTool } from '../../src/loop/types';
import {
  transformSwarmBatch,
  SWARM_BATCH_REORDER_REMINDER,
} from '../../src/loop/transform-swarm-batch';
import type { RunnableToolCall } from '../../src/loop/tool-call';

describe('transformSwarmBatch', () => {
  it('no-op when no AgentSwarm', () => {
    const calls = [makeRunnableToolCall('Read'), makeRunnableToolCall('Bash')];
    const result = transformSwarmBatch(calls);

    expect(result).toMatchObject({ reordered: false, systemReminder: undefined });
    expect(calls.map((c) => c.toolName)).toEqual(['Read', 'Bash']);
  });

  it('no-op when AgentSwarm alone', () => {
    const calls = [makeRunnableToolCall('AgentSwarm')];
    const result = transformSwarmBatch(calls);

    expect(result).toMatchObject({ reordered: false, systemReminder: undefined });
    expect(calls.map((c) => c.toolName)).toEqual(['AgentSwarm']);
  });

  it('no-op when multiple AgentSwarm (deny policy handles this)', () => {
    const calls = [makeRunnableToolCall('AgentSwarm'), makeRunnableToolCall('AgentSwarm')];
    const result = transformSwarmBatch(calls);

    expect(result).toMatchObject({ reordered: false, systemReminder: undefined });
    expect(calls.map((c) => c.toolName)).toEqual(['AgentSwarm', 'AgentSwarm']);
  });

  it('reorder when AgentSwarm is mixed at the end', () => {
    const calls = [
      makeRunnableToolCall('Read'),
      makeRunnableToolCall('Bash'),
      makeRunnableToolCall('AgentSwarm'),
    ];
    const result = transformSwarmBatch(calls);

    expect(result).toMatchObject({ reordered: true, systemReminder: SWARM_BATCH_REORDER_REMINDER });
    expect(calls.map((c) => c.toolName)).toEqual(['Read', 'Bash', 'AgentSwarm']);
  });

  it('reorder when AgentSwarm is first', () => {
    const calls = [makeRunnableToolCall('AgentSwarm'), makeRunnableToolCall('Read')];
    const result = transformSwarmBatch(calls);

    expect(result).toMatchObject({ reordered: true, systemReminder: SWARM_BATCH_REORDER_REMINDER });
    expect(calls.map((c) => c.toolName)).toEqual(['Read', 'AgentSwarm']);
  });

  it('reorder when AgentSwarm is in the middle', () => {
    const calls = [
      makeRunnableToolCall('Read'),
      makeRunnableToolCall('AgentSwarm'),
      makeRunnableToolCall('Write'),
    ];
    const result = transformSwarmBatch(calls);

    expect(result).toMatchObject({ reordered: true, systemReminder: SWARM_BATCH_REORDER_REMINDER });
    expect(calls.map((c) => c.toolName)).toEqual(['Read', 'Write', 'AgentSwarm']);
  });

  it('systemReminder contains key phrases', () => {
    const calls = [makeRunnableToolCall('AgentSwarm'), makeRunnableToolCall('Read')];
    const result = transformSwarmBatch(calls);

    expect(result.systemReminder).toContain('reordered');
    expect(result.systemReminder).toContain('AgentSwarm');
    expect(result.systemReminder).toContain('by itself');
  });
});

function makeRunnableToolCall(toolName: string): RunnableToolCall {
  return {
    kind: 'runnable',
    toolName,
    toolCall: {
      type: 'function',
      id: `call_${toolName.toLowerCase()}`,
      name: toolName,
      arguments: '{}',
    },
    tool: { name: toolName, description: '', inputSchema: {} } as unknown as ExecutableTool,
    args: {},
  };
}
