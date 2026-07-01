import type { Agent } from '../..';
import { isWithinWorkspace } from '../../../tools/policies/path-access';
import { findGitWorkTreeMarker } from '../../../tools/support/git-worktree';
import type { PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { BasePermissionPolicy } from '../base-policy';
import { writeFileAccesses } from './file-access-ask';

export class GitCwdWriteApprovePermissionPolicy extends BasePermissionPolicy {
  readonly name = 'git-cwd-write-approve';
  readonly category = 'approve' as const;

  constructor(private readonly agent: Agent) {
    super();
  }

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    if (this.agent.kaos.pathClass() !== 'posix') return;

    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.agent.getAdditionalDirs() },
          'posix',
        ),
      )
    ) {
      return;
    }

    const marker = await findGitWorkTreeMarker(this.agent.kaos, cwd);
    if (marker === null) return;

    return {
      kind: 'approve',
    };
  }
}
