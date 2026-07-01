import type { Agent } from '../..';
import { isPlainRecord } from '../../turn/canonical-args';
import type { PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';

export class PreToolCallHookPermissionPolicy extends BasePermissionPolicy {
  readonly name = 'pre-tool-call-hook';
  readonly category = 'deny' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const hookResult = await this.agent.hooks?.triggerBlock('PreToolUse', {
      matcherValue: context.toolCall.name,
      signal: context.signal,
      inputData: {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      },
    });
    context.signal.throwIfAborted();
    if (hookResult === undefined) return;
    return {
      kind: 'deny',
      message: hookResult.reason,
    };
  }
}
