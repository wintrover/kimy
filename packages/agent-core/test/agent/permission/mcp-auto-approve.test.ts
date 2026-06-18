import { describe, expect, it } from 'vitest';

import { McpAutoApprovePermissionPolicy } from '../../../src/agent/permission/policies/mcp-auto-approve';
import type { PermissionPolicyContext } from '../../../src/agent/permission/types';
import type { Agent } from '../../../src/agent';

function makeContext(
  overrides: Partial<PermissionPolicyContext> & { annotations?: { readOnlyHint?: boolean } },
): PermissionPolicyContext {
  const base = {
    toolCall: { id: '1', type: 'function' as const, name: 'mcp__code-index__find_files', arguments: '{}' },
    toolCalls: [],
    args: {},
    execution: {
      approvalRule: 'mcp__code-index__find_files',
      execute: async () => ({ output: '' }),
    },
    tool: {
      name: 'mcp__code-index__find_files',
      description: '',
      parameters: {},
      annotations: overrides.annotations,
      resolveExecution: async () => ({
        approvalRule: 'mcp__code-index__find_files',
        execute: async () => ({ output: '' }),
      }),
    },
    turnId: '1',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
  };
  return {
    ...base,
    ...overrides,
    toolCall: overrides.toolCall ?? base.toolCall,
  };
}

function makeAgent(config?: Partial<Agent['kimiConfig']>): Agent {
  return {
    kimiConfig: config,
  } as Agent;
}

describe('McpAutoApprovePermissionPolicy', () => {
  it('approves matching read-only MCP tools', () => {
    const policy = new McpAutoApprovePermissionPolicy(
      makeAgent({
        permission: {
          mcpAutoApprove: [
            {
              pattern: 'mcp__code-index__*',
              readOnlyHint: true,
              reason: 'code-index is read-only',
            },
          ],
        },
      }),
    );
    const result = policy.evaluate(makeContext({ annotations: { readOnlyHint: true } }));
    expect(result).toEqual({
      kind: 'approve',
      reason: {
        rule_source_pattern: 'mcp__code-index__*',
        rule_reason: 'code-index is read-only',
        rule_name: null,
      },
    });
  });

  it('does not approve when annotation hints mismatch', () => {
    const policy = new McpAutoApprovePermissionPolicy(
      makeAgent({
        permission: {
          mcpAutoApprove: [{ pattern: 'mcp__code-index__*', readOnlyHint: true }],
        },
      }),
    );
    expect(policy.evaluate(makeContext({ annotations: { readOnlyHint: false } }))).toBeUndefined();
  });

  it('does not approve non-MCP tools', () => {
    const policy = new McpAutoApprovePermissionPolicy(
      makeAgent({
        permission: {
          mcpAutoApprove: [{ pattern: '*' }],
        },
      }),
    );
    expect(
      policy.evaluate(
        makeContext({ toolCall: { id: '2', type: 'function', name: 'Read', arguments: '{}' } }),
      ),
    ).toBeUndefined();
  });
});
