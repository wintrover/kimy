import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';
import { PolicyPhase } from '../types';

export class YoloModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';
  readonly phase = PolicyPhase.APPROVE;

  constructor(private readonly agent: Agent) {}

  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'yolo') return;
    return {
      kind: 'approve',
    };
  }
}
