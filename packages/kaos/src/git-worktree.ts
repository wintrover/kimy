import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { LocalKaos } from './local';

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────

export interface GitWorktreeHandle {
  /** Absolute path to the worktree root. */
  readonly worktreePath: string;
  /** Remove the worktree (`git worktree remove --force`) and delete the directory. */
  dispose(): Promise<void>;
}

export interface IsolatedWorktreeResult {
  /** A {@link LocalKaos} rooted at the worktree path. */
  kaos: LocalKaos;
  /** Handle for cleanup. */
  worktree: GitWorktreeHandle;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Create an isolated git worktree for an agent by detaching HEAD from
 * the main repository.
 *
 * @param mainRepoPath  Absolute path to the source repository.
 * @param agentId       Unique agent identifier, used in the temp directory name.
 * @returns A `LocalKaos` rooted at the new worktree and a handle for cleanup.
 */
export async function createIsolatedWorktree(
  mainRepoPath: string,
  agentId: string,
): Promise<IsolatedWorktreeResult> {
  const tmpBase = await mkdtemp(join(tmpdir(), `kimi-sandbox-${agentId}-`));
  const worktreePath = join(tmpBase, `kimi-sandbox-${agentId}`);

  await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath], {
    cwd: mainRepoPath,
    env: process.env as Record<string, string>,
  });

  const kaos = await LocalKaos.create();
  const scopedKaos = kaos.withCwd(worktreePath);

  const handle: GitWorktreeHandle = {
    worktreePath,
    async dispose(): Promise<void> {
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: mainRepoPath,
          env: process.env as Record<string, string>,
        });
      } catch {
        // Worktree removal may fail if already gone; fall through to rm.
      }
      await rm(tmpBase, { recursive: true, force: true });
    },
  };

  return { kaos: scopedKaos, worktree: handle };
}
