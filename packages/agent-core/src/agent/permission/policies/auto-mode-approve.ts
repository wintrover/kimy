import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';
import { PolicyPhase } from '../types';

export class AutoModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-approve';
  readonly phase = PolicyPhase.APPROVE;

  constructor(private readonly agent: Agent) {}

  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    return {
      kind: 'approve',
    };
  }
}
