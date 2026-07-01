import type { PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';

export class DenyAllPermissionPolicy extends BasePermissionPolicy {
  readonly name = 'deny-all';
  readonly category = 'deny' as const;

  constructor(private readonly message: string) {
    super();
  }

  evaluate(): PermissionPolicyResult {
    return {
      kind: 'deny',
      message: this.message,
      reason: { source: 'side_question' },
    };
  }
}
