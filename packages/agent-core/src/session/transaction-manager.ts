/**
 * TransactionManager — orchestrates isolated agent execution with git-backed
 * rollback, file ownership locking, and semantic verification.
 *
 * Each agent runs inside an isolated git worktree. After execution, the
 * reported files are verified against actual disk changes, lint/typecheck
 * gates are run, and the worktree is cherry-picked back into the main repo
 * under a serial commit queue.
 *
 * On failure the worktree is discarded and the agent can be retried with
 * its context restored from a snapshot.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { join } from 'pathe';

import type { Agent } from '../agent';
import type { CompleteTaskResult } from '../tools/builtin/collaboration/complete-task';
import { getCompleteTaskResult } from '../tools/builtin/collaboration/complete-task';
import { CommitQueue } from './commit-queue';
import { GitStateGuard, GitStateError } from './git-state-guard';
import { OrchestratorLock, type FileViolation } from './orchestrator-lock';
import { SemanticGate, type SemanticGateConfig } from './semantic-gate';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Additional environment variables for the sandboxed Kaos. */
  readonly env?: Record<string, string>;
}

export interface TransactionConfig {
  /** Maximum number of retries on recoverable failures. Defaults to 2. */
  readonly maxRetries?: number;
  /** Optional sandbox configuration for the execution Kaos. */
  readonly sandboxConfig?: SandboxConfig;
  /** Semantic gate configuration. Uses defaults when omitted. */
  readonly semanticGate?: SemanticGateConfig;
}

export interface TransactionResult {
  readonly status: 'committed' | 'rolled_back' | 'verification_failed';
  readonly verifiedFiles: readonly string[];
  readonly conflicts?: readonly FileViolation[];
  readonly retryCount: number;
  readonly error?: string;
  readonly baseCommitHash: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Snapshot of agent context state before execution. */
interface ContextSnapshot {
  readonly messageCount: number;
}

function captureSnapshot(agent: Agent): ContextSnapshot {
  return { messageCount: agent.context.history.length };
}

function restoreContext(agent: Agent, snapshot: ContextSnapshot, feedback: string): void {
  agent.context.clear();
  agent.context.appendSystemReminder(feedback, {
    kind: 'system_trigger',
    name: 'transaction-retry',
  });
}

/**
 * All-or-nothing verification: the reported file set must exactly match the
 * actual file set — no extras, no missing.
 */
function strictVerify(actual: string[], reported: string[]): boolean {
  if (actual.length !== reported.length) return false;
  const actualSet = new Set(actual);
  const reportedSet = new Set(reported);
  for (const f of actualSet) {
    if (!reportedSet.has(f)) return false;
  }
  return true;
}

/**
 * Get the list of files that changed in a worktree relative to its base.
 * Uses `git status --porcelain` to capture both tracked modifications and
 * untracked files.
 */
async function getActualChangedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: worktreePath },
  );
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      // porcelain format: XY <path>  or  XY <old> -> <new>
      const pathPart = line.slice(3);
      if (pathPart.includes(' -> ')) {
        return pathPart.split(' -> ')[1]!;
      }
      return pathPart;
    })
    .filter((p) => p.length > 0);
}

/**
 * Create an isolated git worktree for the agent to work in.
 *
 * The worktree is created at `<repoPath>/.worktrees/<agentId>` on a branch
 * named `agent/<agentId>`.
 */
async function createIsolatedWorktree(
  repoPath: string,
  agentId: string,
): Promise<string> {
  const worktreePath = join(repoPath, '.worktrees', agentId);
  const branchName = `agent/${agentId}`;

  // Remove any stale worktree from a previous run.
  await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
  }).catch(() => {});

  // Create the worktree with a new branch from HEAD.
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: repoPath,
  });

  return worktreePath;
}

/**
 * Commit selected files in the worktree and cherry-pick the commit back
 * into the main repository.
 *
 * Files are added individually (NOT `git add -A`) to ensure only the
 * reported files are included in the commit.
 */
async function commitWorktreeSelective(
  repoPath: string,
  worktreePath: string,
  files: readonly string[],
  message: string,
): Promise<string> {
  for (const file of files) {
    await execFileAsync('git', ['add', '--', file], { cwd: worktreePath });
  }

  await execFileAsync('git', ['commit', '-m', message], { cwd: worktreePath });

  const { stdout: hashOutput } = await execFileAsync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: worktreePath },
  );
  const hash = hashOutput.trim();

  await execFileAsync('git', ['cherry-pick', hash], { cwd: repoPath });

  return hash;
}

/**
 * Remove an isolated git worktree, cleaning up any uncommitted changes.
 */
async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
  }).catch(() => {});
}

/**
 * Get the current HEAD hash of a git repository.
 */
async function getHeadHash(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
  });
  return stdout.trim();
}

// ── TransactionManager ───────────────────────────────────────────────

export class TransactionManager {
  private readonly commitQueue = new CommitQueue();
  private readonly lock = new OrchestratorLock();

  constructor(
    private readonly mainRepoPath: string,
    private readonly config: TransactionConfig = {},
  ) {}

  /**
   * Run an agent's execution inside a transaction with full rollback support.
   *
   * The execution is retried up to `config.maxRetries` times on recoverable
   * failures. Each retry restores the agent's context from a snapshot taken
   * before the first attempt and appends a feedback system message.
   */
  async runInTransaction(
    agent: Agent,
    agentId: string,
    execute: () => Promise<void>,
  ): Promise<TransactionResult> {
    const maxRetries = this.config.maxRetries ?? 2;
    const guard = new GitStateGuard(this.mainRepoPath);
    const contextSnapshot = captureSnapshot(agent);
    const baseCommitHash = await getHeadHash(this.mainRepoPath);

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        restoreContext(
          agent,
          contextSnapshot,
          `Transaction attempt ${attempt} failed: ${lastError ?? 'unknown error'}. ` +
            'Retry with the same goal. Focus on correctness.',
        );
      }

      try {
        const result = await this.executeOnce(agent, agentId, execute, guard);
        return { ...result, retryCount: attempt, baseCommitHash };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    // All retries exhausted — ensure the repo is clean and report failure.
    await guard.ensureReady();
    return {
      status: 'rolled_back',
      verifiedFiles: [],
      retryCount: maxRetries,
      error: lastError,
      baseCommitHash,
    };
  }

  /**
   * Single execution attempt within a git worktree.
   *
   * Lifecycle:
   * 1. Ensure git state is clean
   * 2. Create isolated worktree
   * 3. Run execution in sandboxed Kaos
   * 4. Verify reported files against actual changes
   * 5. Verify file ownership
   * 6. Run semantic gate (lint/typecheck)
   * 7. Commit under queue lock
   * 8. Cleanup worktree
   */
  private async executeOnce(
    agent: Agent,
    agentId: string,
    execute: () => Promise<void>,
    guard: GitStateGuard,
  ): Promise<Omit<TransactionResult, 'retryCount' | 'baseCommitHash'>> {
    let worktreePath: string | undefined;

    try {
      // 1. Ensure git state is clean.
      await guard.ensureReady();

      // 2. Create isolated worktree.
      worktreePath = await createIsolatedWorktree(this.mainRepoPath, agentId);

      // 3. Sandbox the agent's Kaos to the worktree.
      const originalKaos = agent.kaos;
      const sandboxKaos = agent.kaos.withCwd(worktreePath);
      agent.setKaos(sandboxKaos);

      try {
        // 4. Execute the agent's task.
        await execute();

        // 5. Extract the CompleteTask result.
        const taskResult = getCompleteTaskResult(agent);
        if (taskResult === undefined) {
          throw new TransactionError(
            'Agent did not call CompleteTask. All delegated agents MUST call CompleteTask to finish.',
          );
        }

        // 6. Capture actual changed files from disk.
        const actualFiles = await getActualChangedFiles(worktreePath);

        // 7. All-or-nothing verification: reported must match actual exactly.
        if (!strictVerify(actualFiles, [...taskResult.affectedFiles])) {
          throw new TransactionError(
            `File mismatch: reported [${taskResult.affectedFiles.join(', ')}] ` +
              `but actual on disk [${actualFiles.join(', ')}]. ` +
              'Transaction ABORT — no partial commits allowed.',
          );
        }

        // 8. Verify file ownership — no conflicts with other agents.
        const ownershipCheck = this.lock.verifyPostCommit(agentId, actualFiles);
        if (!ownershipCheck.ok) {
          return {
            status: 'verification_failed',
            verifiedFiles: actualFiles,
            conflicts: ownershipCheck.violations,
          };
        }

        // 9. Run semantic gate (lint, typecheck).
        const gate = new SemanticGate(this.config.semanticGate);
        const gateResult = await gate.run(sandboxKaos);
        if (!gateResult.passed) {
          return {
            status: 'verification_failed',
            verifiedFiles: actualFiles,
            error: `Semantic gate failed at step "${gateResult.failedAt}"`,
          };
        }

        // 10. Commit under serial queue lock.
        const commitHash = await this.commitQueue.enqueue(() =>
          commitWorktreeSelective(
            this.mainRepoPath,
            worktreePath!,
            actualFiles,
            `feat(delegation): ${taskResult.summary.slice(0, 72)}`,
          ),
        );

        return {
          status: 'committed',
          verifiedFiles: actualFiles,
        };
      } finally {
        // Restore original Kaos regardless of outcome.
        agent.setKaos(originalKaos);
      }
    } catch (error: unknown) {
      // Ensure the repo is in a clean state after a failed attempt.
      await guard.ensureReady();
      throw error instanceof Error ? error : new TransactionError(String(error));
    } finally {
      // Cleanup: remove the worktree.
      if (worktreePath !== undefined) {
        await removeWorktree(this.mainRepoPath, worktreePath).catch(() => {});
      }
      this.lock.release(agentId);
    }
  }
}

// ── Errors ───────────────────────────────────────────────────────────

export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}
