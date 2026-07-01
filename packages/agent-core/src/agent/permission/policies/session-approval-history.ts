import type { Agent } from '../..';
import {
  matchPermissionRule,
  type PermissionRuleMatch,
} from '../matches-rule';
import type {
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';
import { BasePermissionPolicy } from '../base-policy';

export class SessionApprovalHistoryPermissionPolicy extends BasePermissionPolicy {
  readonly name = 'session-approval-history';
  readonly category = 'approve' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.matchSessionApprovalRule(context);
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: {
        has_rule_args: match.hasRuleArgs,
        match_strategy: match.strategy,
      },
    };
  }

  private matchSessionApprovalRule(
    context: PermissionPolicyContext,
  ): PermissionRuleMatch | undefined {
    for (const pattern of this.agent.permission.sessionApprovalRulePatterns) {
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
  }
}
