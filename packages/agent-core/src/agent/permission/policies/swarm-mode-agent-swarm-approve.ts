import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { PolicyPhase } from '../types';

export class SwarmModeAgentSwarmApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';
  readonly phase = PolicyPhase.APPROVE;

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return;
    if (!this.agent.swarmMode.isActive) return;
    return {
      kind: 'approve',
    };
  }
}
