import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { PolicyPhase } from '../types';

export class AgentSwarmExclusiveDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'agent-swarm-exclusive-deny';
  readonly phase = PolicyPhase.DENY;

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolCalls = context.toolCalls;
    const agentSwarmCount = toolCalls.filter(
      (toolCall) => toolCall.name === 'AgentSwarm',
    ).length;

    if (agentSwarmCount === 0) return;
    if (agentSwarmCount === 1 && toolCalls.length === 1) return;
    if (agentSwarmCount === 1) return;

    return {
      kind: 'deny',
      message:
        agentSwarmCount > 1
          ? multipleAgentSwarmDeniedMessage()
          : mixedAgentSwarmDeniedMessage(),
      reason: {
        agent_swarm_tool_calls: agentSwarmCount,
        tool_calls: toolCalls.length,
      },
    };
  }
}

function multipleAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be called one swarm at a time. Issue them sequentially: call one AgentSwarm, ' +
    'wait for its result, then call the next. Multiple AgentSwarm calls in the same response are not allowed.'
  );
}

function mixedAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm ' +
    'call by itself, then call any other tools after it returns.'
  );
}
