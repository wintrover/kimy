import type { Agent } from '../..';
import type { PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';

export class SwarmModeAgentSwarmApprovePermissionPolicy extends BasePermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';
  readonly category = 'approve' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return;
    if (!this.agent.swarmMode.isActive) return;
    return {
      kind: 'approve',
    };
  }
}
