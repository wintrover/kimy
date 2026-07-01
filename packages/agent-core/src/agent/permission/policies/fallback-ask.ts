import { BasePermissionPolicy } from '../base-policy';
import type { PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class FallbackAskPermissionPolicy extends BasePermissionPolicy {
  readonly name = 'fallback-ask';
  readonly category = 'ask_resource' as const;

  evaluate(_context: PermissionPolicyContext): PermissionPolicyResult {
    return {
      kind: 'ask',
    };
  }
}
