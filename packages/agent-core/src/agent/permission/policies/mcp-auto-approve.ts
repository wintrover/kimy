import picomatch from 'picomatch';

import type { Agent } from '../..';
import type { McpAutoApproveRule } from '../../../config/schema';
import type { MCPToolAnnotations } from '../../../mcp/types';
import { isMcpToolName } from '../../../mcp/tool-naming';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';
import { PolicyPhase } from '../types';

export class McpAutoApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'mcp-auto-approve';
  readonly phase = PolicyPhase.APPROVE;

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (!isMcpToolName(toolName)) return undefined;

    const rules = this.agent.kimiConfig?.permission?.mcpAutoApprove;
    if (rules === undefined || rules.length === 0) return undefined;

    const annotations = context.tool?.annotations;
    for (const rule of rules) {
      if (!picomatch.isMatch(toolName, rule.pattern)) continue;
      if (!annotationMatches(rule, annotations)) continue;
      return {
        kind: 'approve',
        reason: {
          rule_source_pattern: rule.pattern,
          rule_reason: rule.reason ?? null,
          rule_name: rule.name ?? null,
        },
      };
    }

    return undefined;
  }
}

function annotationMatches(rule: McpAutoApproveRule, annotations: MCPToolAnnotations | undefined): boolean {
  if (annotations === undefined) {
    // If the rule specifies annotation hints but the tool has none, it does not match.
    return !hasAnnotationHints(rule);
  }
  if (rule.readOnlyHint !== undefined && rule.readOnlyHint !== annotations.readOnlyHint) return false;
  if (rule.destructiveHint !== undefined && rule.destructiveHint !== annotations.destructiveHint)
    return false;
  if (rule.idempotentHint !== undefined && rule.idempotentHint !== annotations.idempotentHint)
    return false;
  if (rule.openWorldHint !== undefined && rule.openWorldHint !== annotations.openWorldHint)
    return false;
  return true;
}

function hasAnnotationHints(rule: McpAutoApproveRule): boolean {
  return (
    rule.readOnlyHint !== undefined ||
    rule.destructiveHint !== undefined ||
    rule.idempotentHint !== undefined ||
    rule.openWorldHint !== undefined
  );
}
