import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AgentSwarmExclusiveDenyPermissionPolicy } from './agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicy } from './auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicy } from './exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicy } from './swarm-mode-agent-swarm-approve';
import { McpAutoApprovePermissionPolicy } from './mcp-auto-approve';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { YoloModeApprovePermissionPolicy } from './yolo-mode-approve';

/** Permission policies; evaluated in phase order (DENY → GUARD → APPROVE → FALLBACK). Within a phase, registration order applies. */
export function createPermissionDecisionPolicies(agent: Agent): PermissionPolicy[] {
  return [
    // --- DENY phase ---
    new PreToolCallHookPermissionPolicy(agent),
    new AgentSwarmExclusiveDenyPermissionPolicy(),
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    new PlanModeGuardDenyPermissionPolicy(agent),
    new UserConfiguredDenyPermissionPolicy(agent),
    // --- GUARD phase ---
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    new SensitiveFileAccessAskPermissionPolicy(agent),
    new GitControlPathAccessAskPermissionPolicy(agent),
    // --- APPROVE phase ---
    new AutoModeApprovePermissionPolicy(agent),
    new SessionApprovalHistoryPermissionPolicy(agent),
    new UserConfiguredAskPermissionPolicy(agent),
    new UserConfiguredAllowPermissionPolicy(agent),
    new McpAutoApprovePermissionPolicy(agent),
    new PlanModeToolApprovePermissionPolicy(agent),
    new YoloModeApprovePermissionPolicy(agent),
    new SwarmModeAgentSwarmApprovePermissionPolicy(agent),
    new DefaultToolApprovePermissionPolicy(),
    new GitCwdWriteApprovePermissionPolicy(agent),
    // --- FALLBACK phase ---
    new FallbackAskPermissionPolicy(),
  ];
}
