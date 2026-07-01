import type { Agent } from '../..';
import type { PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';

export class AutoModeApprovePermissionPolicy extends BasePermissionPolicy {
  readonly name = 'auto-mode-approve';
  readonly category = 'approve' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    return {
      kind: 'approve',
    };
  }
}
