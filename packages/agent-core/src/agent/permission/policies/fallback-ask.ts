import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { PolicyPhase } from '../types';

export class FallbackAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'fallback-ask';
  readonly phase = PolicyPhase.FALLBACK;

  evaluate(_context: PermissionPolicyContext): PermissionPolicyResult {
    return {
      kind: 'ask',
    };
  }
}
