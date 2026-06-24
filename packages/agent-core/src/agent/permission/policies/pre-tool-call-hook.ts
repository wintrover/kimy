import type { Agent } from '../..';
import { isPlainRecord } from '../../turn/canonical-args';
import { computeOverrideContext } from '#/guardrail/override-context';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { PolicyPhase } from '../types';

export class PreToolCallHookPermissionPolicy implements PermissionPolicy {
  readonly name = 'pre-tool-call-hook';
  readonly phase = PolicyPhase.DENY;

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const overrides = this.agent.kimiConfig?.executionGuardrails?.overrides;
    const args = isPlainRecord(context.args) ? context.args : null;
    const guardrail = computeOverrideContext(overrides, context.toolCall.name, args);

    const hookResult = await this.agent.hooks?.triggerBlock('PreToolUse', {
      matcherValue: context.toolCall.name,
      signal: context.signal,
      inputData: {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
        ...(guardrail !== undefined ? { guardrail } : {}),
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
