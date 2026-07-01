import type { Agent } from '../..';
import { DenyOverrides, FirstApplicable } from '../pipeline';
import type { PermissionPipeline } from '../pipeline';
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
import { GoalStartReviewAskPermissionPolicy } from './goal-start-review-ask';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicy } from './swarm-mode-agent-swarm-approve';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';

/**
 * Build the three-layer permission pipeline for the given agent.
 *
 * Structure:
 *   guards     — deny-only; DenyOverrides combining (any deny wins).
 *   overrides  — user/session overrides; FirstApplicable combining (array order = priority, ask beats allow).
 *   fallbacks  — last resort; FirstApplicable combining (first result wins).
 */
export function createPermissionPipeline(agent: Agent): PermissionPipeline {
  return {
    guards: {
      combine: DenyOverrides,
      policies: [
        // PreToolUse hook returned a block → deny.
        new PreToolCallHookPermissionPolicy(agent),
        // AgentSwarm is batch-exclusive and must run alone, regardless of permission mode.
        new AgentSwarmExclusiveDenyPermissionPolicy(),
        // auto mode + AskUserQuestion → deny.
        new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
        // plan mode: Write/Edit outside the plan file, or TaskStop → deny.
        new PlanModeGuardDenyPermissionPolicy(agent),
        // User-configured deny rule matches → deny.
        new UserConfiguredDenyPermissionPolicy(agent),
      ],
    },
    overrides: {
      combine: FirstApplicable,
      policies: [
        // auto mode → approve (any auto-mode block must be a deny rule in guards).
        new AutoModeApprovePermissionPolicy(agent),
        // Approve-for-session memorized rule matches → approve.
        new SessionApprovalHistoryPermissionPolicy(agent),
        // User-configured ask rule matches → ask_resource (skipped in yolo).
        new UserConfiguredAskPermissionPolicy(agent),
        // User-configured allow rule matches → approve.
        new UserConfiguredAllowPermissionPolicy(agent),
        // ExitPlanMode with active plan_review + non-empty plan + non-auto → ask_lifecycle (never skipped in yolo).
        new ExitPlanModeReviewAskPermissionPolicy(agent),
        // CreateGoal (non-auto) → ask_lifecycle.
        new GoalStartReviewAskPermissionPolicy(agent),
        // EnterPlanMode, Write/Edit on the plan file, or ExitPlanMode with no actionable plan_review → approve.
        new PlanModeToolApprovePermissionPolicy(agent),
      ],
    },
    fallbacks: {
      combine: FirstApplicable,
      policies: [
        // Access touches a sensitive file (.env, SSH key, credentials) → ask_resource.
        new SensitiveFileAccessAskPermissionPolicy(),
        // Access touches .git or a git control-dir path → ask_resource.
        new GitControlPathAccessAskPermissionPolicy(agent),
        // Swarm mode keeps AgentSwarm available without making it a globally default-approved tool.
        new SwarmModeAgentSwarmApprovePermissionPolicy(agent),
        // Tool is in the default-approve list (read-only / UI helpers) → approve.
        new DefaultToolApprovePermissionPolicy(),
        // Write/Edit on POSIX paths inside cwd inside a git work tree → approve.
        new GitCwdWriteApprovePermissionPolicy(agent),
        // Nothing matched → ask_resource.
        new FallbackAskPermissionPolicy(),
      ],
    },
  };
}
