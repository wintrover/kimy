import { PolicyPhase } from '../types';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

export class DenyAllPermissionPolicy implements PermissionPolicy {
  readonly name = 'deny-all';
  readonly phase = PolicyPhase.DENY;

  constructor(private readonly message: string) {}

  evaluate(): PermissionPolicyResult {
    return {
      kind: 'deny',
      message: this.message,
      reason: { source: 'side_question' },
    };
  }
}
