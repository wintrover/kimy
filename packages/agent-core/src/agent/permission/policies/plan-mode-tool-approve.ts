import type { Agent } from '../..';
import type { PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';
import { writeFileAccesses } from './file-access-ask';

export class PlanModeToolApprovePermissionPolicy extends BasePermissionPolicy {
  readonly name = 'plan-mode-tool-approve';
  readonly category = 'approve' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterPlanMode') {
      return {
        kind: 'approve',
      };
    }

    if (
      (toolName === 'Write' || toolName === 'Edit') &&
      this.agent.planMode.isActive &&
      writesOnlyPlanFile(context, this.agent.planMode.planFilePath)
    ) {
      return {
        kind: 'approve',
      };
    }

    if (toolName === 'ExitPlanMode') {
      if (!this.agent.planMode.isActive) {
        return {
          kind: 'approve',
        };
      }
      if (context.execution.display?.kind !== 'plan_review') {
        return {
          kind: 'approve',
        };
      }
      if (context.execution.display.plan.trim().length > 0) return;
      return {
        kind: 'approve',
      };
    }
  }
}

function writesOnlyPlanFile(
  context: PermissionPolicyContext,
  planFilePath: string | null,
): boolean {
  if (planFilePath === null) return false;
  const writeAccesses = writeFileAccesses(context);
  return writeAccesses.every((access) => access.path === planFilePath);
}
