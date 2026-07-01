/**
 * GitStateGuard — detects and recovers stuck git states.
 *
 * When agents run cherry-pick or other destructive git operations, the repo
 * can be left in a mid-operation state (e.g. CHERRY_PICK_HEAD exists). This
 * guard detects such states and can abort them to restore a clean working
 * tree before the next operation.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

import { join } from 'pathe';

const execFileAsync = promisify(execFile);

const GIT_SENTINELS = [
  'CHERRY_PICK_HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
] as const;

export type GitOperation = 'cherry-pick' | 'merge' | 'rebase' | 'revert' | 'bisect';

export interface GitStateCheckResult {
  readonly clean: boolean;
  readonly stuckOperation?: GitOperation;
  readonly sentinelFile?: string;
}

const SENTINEL_TO_OP: Record<string, GitOperation> = {
  CHERRY_PICK_HEAD: 'cherry-pick',
  MERGE_HEAD: 'merge',
  REBASE_HEAD: 'rebase',
  REVERT_HEAD: 'revert',
  BISECT_LOG: 'bisect',
};

const ABORT_COMMANDS: Record<GitOperation, string[]> = {
  'cherry-pick': ['cherry-pick', '--abort'],
  merge: ['merge', '--abort'],
  rebase: ['rebase', '--abort'],
  revert: ['revert', '--abort'],
  bisect: ['bisect', 'reset'],
};

export class GitStateGuard {
  constructor(private readonly repoPath: string) {}

  /**
   * Check whether the repository is in a clean state.
   *
   * Examines the `.git` directory for sentinel files that indicate a
   * mid-operation state.
   */
  async check(): Promise<GitStateCheckResult> {
    for (const sentinel of GIT_SENTINELS) {
      try {
        await access(join(this.repoPath, '.git', sentinel));
        return {
          clean: false,
          stuckOperation: SENTINEL_TO_OP[sentinel]!,
          sentinelFile: sentinel,
        };
      } catch {
        // file not found = clean for this sentinel
      }
    }
    return { clean: true };
  }

  /**
   * Attempt to abort a stuck git operation.
   *
   * First tries the operation-specific abort command (e.g. `git cherry-pick
   * --abort`). If that fails, falls back to `git reset --hard HEAD`.
   */
  async recover(): Promise<void> {
    const state = await this.check();
    if (state.clean) return;

    const cmd = ABORT_COMMANDS[state.stuckOperation!];
    try {
      await execFileAsync('git', cmd, {
        cwd: this.repoPath,
        timeout: 10_000,
      });
    } catch {
      await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
        cwd: this.repoPath,
        timeout: 10_000,
      }).catch(() => {});
    }
  }

  /**
   * Ensure the repository is in a ready state. If stuck, attempt recovery.
   *
   * @throws {GitStateError} if the repository cannot be recovered.
   */
  async ensureReady(): Promise<void> {
    const state = await this.check();
    if (state.clean) return;

    await this.recover();

    const after = await this.check();
    if (!after.clean) {
      throw new GitStateError(
        `Repository stuck in ${after.stuckOperation} state (sentinel: ${after.sentinelFile})`,
      );
    }
  }

  /**
   * Attempt a cherry-pick of the given commit hash.
   *
   * On conflict, lists the conflicting files and then aborts the cherry-pick
   * so the repo returns to a clean state.
   */
  async cherryPick(
    hash: string,
  ): Promise<{ success: boolean; conflicts?: string[] }> {
    try {
      await execFileAsync('git', ['cherry-pick', hash], {
        cwd: this.repoPath,
        timeout: 30_000,
      });
      return { success: true };
    } catch {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--name-only', '--diff-filter=U'],
          { cwd: this.repoPath },
        );
        return {
          success: false,
          conflicts: stdout.trim().split('\n').filter(Boolean),
        };
      } finally {
        await execFileAsync('git', ['cherry-pick', '--abort'], {
          cwd: this.repoPath,
        }).catch(() => {});
      }
    }
  }
}

export class GitStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitStateError';
  }
}
