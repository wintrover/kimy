import type { Agent } from '..';
import type { PrepareToolExecutionResult } from '../../loop';
import { createPermissionPipeline } from './policies';
import type { PermissionPipeline } from './pipeline';
import type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyCategory,
  PermissionPolicyContext,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  PermissionRule,
} from './types';

export * from './types';

/**
 * Declarative mode matrix — maps each permission mode to the set of policy
 * categories that should be evaluated. Adding a new category to
 * `PermissionPolicyCategory` forces a compile error here, guaranteeing that
 * every category is explicitly allowed or disallowed per mode.
 */
const POLICY_EXECUTION_MATRIX: Record<PermissionMode, Record<PermissionPolicyCategory, boolean>> = {
  manual: { deny: true, approve: true, ask_resource: true, ask_lifecycle: true },
  auto:   { deny: true, approve: true, ask_resource: true, ask_lifecycle: true },
  yolo:   { deny: true, approve: true, ask_resource: false, ask_lifecycle: true },
};

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: PermissionManager;
}

interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export class PermissionManager {
  readonly pipeline: PermissionPipeline;
  readonly rules: PermissionRule[] = [];

  /**
   * Mutable policy list — proxies to the guards layer.
   *
   * Backward-compatible accessor used by callers that inject runtime deny
   * policies (e.g. btw subagents). Adding to the guards layer ensures the
   * injected policy fires before any overrides or fallbacks.
   */
  get policies(): PermissionPolicy[] {
    return this.pipeline.guards.policies;
  }
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly localSessionApprovalRulePatterns = new Set<string>();

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.pipeline = createPermissionPipeline(this.agent);
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? this.parent?.mode ?? 'manual';
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  data(): PermissionData {
    return {
      mode: this.mode,
      rules: this.effectiveRules,
    };
  }

  setMode(mode: PermissionMode): void {
    this.agent.records.logRecord({
      type: 'permission.set_mode',
      mode,
    });
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.modeOverride = mode;
    this.agent.emitStatusUpdated();
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.agent.records.logRecord({
      type: 'permission.record_approval_result',
      ...record,
    });
    this.agent.replayBuilder.push({
      type: 'approval_result',
      record,
    });
    if (record.result.decision !== 'approved' || record.result.scope !== 'session') {
      return;
    }
    const pattern = record.sessionApprovalRule;
    if (pattern === undefined) return;
    this.localSessionApprovalRulePatterns.add(pattern);
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [
      ...this.localSessionApprovalRulePatterns,
      ...(this.parent?.sessionApprovalRulePatterns ?? []),
    ];
  }

  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    this.agent.telemetry.track('permission_policy_decision', {
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    return this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private async requestToolApproval(
    context: PermissionPolicyContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.name;
    const display =
      context.execution.display ?? {
        kind: 'generic',
        summary: context.execution.description ?? `Approve ${name}`,
        detail: context.args,
      };
    const action = context.execution.description ?? `Call ${name}`;
    const startedAt = Date.now();

    let response: ApprovalResponse;
    let requestedApproval = false;
    if (this.agent.rpc?.requestApproval) {
      requestedApproval = true;
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionRequest', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          toolInput: context.args,
          display,
        },
      });
      try {
        response = await this.agent.rpc.requestApproval(
          {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            display,
          },
          { signal },
        );
      } catch (error) {
        this.agent.telemetry.track('permission_approval_result', {
          policy_name: policyName ?? null,
          tool_name: name,
          permission_mode: this.mode,
          result: 'error',
          approval_surface: display.kind,
          duration_ms: Date.now() - startedAt,
          session_cache_written: false,
          has_feedback: false,
        });
        void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
          matcherValue: name,
          inputData: {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            decision: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        const resolved = result.resolveError?.(error);
        return resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
      }
    } else {
      response = {
        decision: 'approved',
      };
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;

    if (requestedApproval) {
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          decision: response.decision,
          scope: response.scope,
          feedback: response.feedback,
          selectedLabel: response.selectedLabel,
        },
      });
    }

    this.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.agent.telemetry.track('permission_approval_result', {
      policy_name: policyName ?? null,
      tool_name: name,
      permission_mode: this.mode,
      result:
        response.decision === 'approved' && response.scope === 'session'
          ? 'approved_for_session'
          : response.decision,
      approval_surface: display.kind,
      duration_ms: Date.now() - startedAt,
      session_cache_written: sessionApprovalRule !== undefined,
      has_feedback: response.feedback !== undefined && response.feedback.length > 0,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    if (response.decision === 'approved') {
      return undefined;
    }

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  private async evaluatePolicies(
    context: PermissionPolicyContext,
  ): Promise<PolicyEvaluation | undefined> {
    const modeGate = POLICY_EXECUTION_MATRIX[this.mode];
    const layers = [this.pipeline.guards, this.pipeline.overrides, this.pipeline.fallbacks];

    for (const layer of layers) {
      const activePolicies = layer.policies.filter((p) => modeGate[p.category]);

      // Parallel evaluation — evaluate() is side-effect-free so temporal
      // ordering has no influence on the result.
      const evaluated = await Promise.all(
        activePolicies.map(async (policy) => {
          const result = await policy.evaluate(context);
          return result !== undefined ? { policyName: policy.name, result } : null;
        }),
      );
      const decisions = evaluated.filter(
        (d): d is NonNullable<typeof d> => d !== null,
      );

      if (decisions.length === 0) continue;

      // Combining algorithm deterministically selects the winning decision kind.
      const combined = layer.combine(decisions);
      if (combined === undefined) continue;

      // Tie-handling: call onSelected() for every policy whose result kind
      // matches the winner, so no side-effect is missed regardless of array order.
      const winners = decisions.filter((d) => d.result.kind === combined.kind);
      for (const winner of winners) {
        const policy = activePolicies.find((p) => p.name === winner.policyName);
        policy?.onSelected?.(context, winner.result);
      }

      // Return the primary winner. For ask policies, at most one matches per
      // tool call, so there is no ambiguity in resolveApproval selection.
      const primary = winners[0]!;
      return { policyName: primary.policyName, result: primary.result };
    }

    // yolo mode: if no deny policy fired, auto-approve.
    if (this.mode === 'yolo') {
      return { policyName: 'yolo-auto-approve', result: { kind: 'approve' } };
    }
    return undefined;
  }

  private get effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules ?? [])];
  }

  private permissionPolicyResolutionToPrepare(
    result: PermissionPolicyResolution,
    context: PermissionPolicyContext,
    policyName?: string,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  protected formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.agent.type === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.agent.type === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}
