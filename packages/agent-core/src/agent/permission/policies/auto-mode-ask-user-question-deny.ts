import type { Agent } from '../..';
import type { PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';

export class AutoModeAskUserQuestionDenyPermissionPolicy extends BasePermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';
  readonly category = 'deny' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    if (context.toolCall.name !== 'AskUserQuestion') return;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  }
}
