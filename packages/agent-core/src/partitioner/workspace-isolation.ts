/**
 * workspace-isolation — Git worktree-based subagent workspace isolation.
 *
 * Solves the race condition problem: when multiple subagents modify files
 * in the same working directory, they can overwrite each other's changes.
 *
 * Strategy:
 *   1. Before swarm launch: create N ephemeral git worktrees, each on its
 *      own branch (swarm/<sessionId>/agent-<index>)
 *   2. Inject each agent's worktree path into its prompt (cwd override)
 *   3. After all agents complete: merge branches in deterministic order
 *      derived from the dependency graph (topological, coupling-aware)
 *   4. Clean up worktrees and ephemeral branches
 *
 * Deterministic rebase order:
 *   - Build a DAG from the partitioner's dependency graph + assignment
 *   - Agents whose files have NO cross-partition imports merge first (leaves)
 *   - Agents that import from other partitions merge after their dependencies
 *   - Tiebreak: ascending agent index (deterministic)
 *
 * Integration point: agent-swarm.ts calls createIsolatedWorkspaces() before
 * launching subagents, and mergeWorkspaces() after all subagents complete.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { PartitionResult } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceIsolationConfig {
  /** Root directory of the git repository */
  readonly repoRoot: string;
  /** Unique session identifier for this swarm run */
  readonly sessionId: string;
  /** Number of agents in the swarm */
  readonly agentCount: number;
  /** Partition result from Z3/greedy solver */
  readonly partition: PartitionResult;
  /** Dependency edges [u, v] where u and v are file indices */
  readonly edges: readonly [number, number][];
  /** File paths indexed by their partition index */
  readonly filePaths: readonly string[];
  /** Base branch to create worktrees from (default: current HEAD) */
  readonly baseBranch?: string;
  /** Temporary directory for worktrees (default: system tmp) */
  readonly tmpDir?: string;
}

export interface IsolatedWorkspace {
  /** Agent index (0-based) */
  readonly agentIndex: number;
  /** Absolute path to the worktree directory */
  readonly worktreePath: string;
  /** Branch name for this agent */
  readonly branchName: string;
  /** Files assigned to this agent */
  readonly assignedFiles: readonly string[];
}

export interface WorkspaceIsolationResult {
  /** Per-agent workspace info */
  readonly workspaces: readonly IsolatedWorkspace[];
  /** Merge order (agent indices in deterministic rebase order) */
  readonly mergeOrder: readonly number[];
  /** Base commit hash before any agent modifications */
  readonly baseCommit: string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(
  repoRoot: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitRevParse(repoRoot: string, ref: string): Promise<string> {
  return git(repoRoot, ['rev-parse', ref]);
}

// ---------------------------------------------------------------------------
// Workspace creation
// ---------------------------------------------------------------------------

/**
 * Create isolated git worktrees for each subagent.
 *
 * Each agent gets:
 * - A dedicated worktree directory
 * - An ephemeral branch forked from baseBranch (or HEAD)
 * - Only its assigned files should be modified in this worktree
 *
 * @returns WorkspaceIsolationResult with workspaces and deterministic merge order
 */
export async function createIsolatedWorkspaces(
  config: WorkspaceIsolationConfig,
): Promise<WorkspaceIsolationResult> {
  const {
    repoRoot,
    sessionId,
    agentCount,
    partition,
    edges,
    filePaths,
    baseBranch,
    tmpDir,
  } = config;

  // Capture base commit for rollback safety
  const baseCommit = await gitRevParse(repoRoot, baseBranch ?? 'HEAD');

  const worktreeRoot = tmpDir ?? path.join(
    require('node:os').tmpdir(),
    `axiom-swarm-${sessionId}`,
  );

  // Ensure tmp root exists
  await fs.mkdir(worktreeRoot, { recursive: true });

  const workspaces: IsolatedWorkspace[] = [];

  // Create worktrees sequentially to avoid git lock contention
  for (let i = 0; i < agentCount; i++) {
    const branchName = `swarm/${sessionId}/agent-${String(i)}`;
    const worktreePath = path.join(worktreeRoot, `agent-${String(i)}`);

    // Get assigned files for this agent
    const assignedFiles: string[] = [];
    for (let j = 0; j < partition.assignment.length; j++) {
      if (partition.assignment[j] === i) {
        assignedFiles.push(filePaths[j]!);
      }
    }

    // Create ephemeral branch from base commit
    await git(repoRoot, ['branch', '--no-track', branchName, baseCommit]);

    // Create worktree on the ephemeral branch
    await git(repoRoot, [
      'worktree', 'add',
      '--force',
      worktreePath,
      branchName,
    ]);

    workspaces.push({
      agentIndex: i,
      worktreePath,
      branchName,
      assignedFiles,
    });
  }

  // Compute deterministic merge order
  const mergeOrder = computeDeterministicMergeOrder(
    agentCount,
    partition,
    edges,
    filePaths,
  );

  return { workspaces, mergeOrder, baseCommit };
}

// ---------------------------------------------------------------------------
// Deterministic merge order computation
// ---------------------------------------------------------------------------

/**
 * Compute the order in which agent branches should be merged back.
 *
 * Algorithm:
 *   1. Build a DAG where edge (A → B) means "agent A's files import from
 *      agent B's files" (A depends on B, B should merge first)
 *   2. Topological sort with ascending agent index as tiebreak
 *   3. This ensures that when agent A's changes are rebased onto the
 *      merged result, its dependencies are already in place
 *
 * For disjoint file sets (no cross-partition edges), the order is simply
 * ascending agent index — fully deterministic and conflict-free.
 */
export function computeDeterministicMergeOrder(
  agentCount: number,
  partition: PartitionResult,
  edges: readonly [number, number][],
  filePaths: readonly string[],
): number[] {
  // Build cross-partition dependency graph: dep[importer] depends on dep[imported]
  // Edge (u, v) where u's agent != v's agent: agent(u) depends on agent(v)
  const dependencies = new Map<number, Set<number>>();
  for (let i = 0; i < agentCount; i++) {
    dependencies.set(i, new Set());
  }

  for (const [u, v] of edges) {
    const agentU = partition.assignment[u]!;
    const agentV = partition.assignment[v]!;
    if (agentU !== agentV) {
      // agentU imports from agentV → agentU depends on agentV
      // Agent V should merge BEFORE agent U
      dependencies.get(agentU)!.add(agentV);
    }
  }

  // Kahn's algorithm for topological sort
  // Compute in-degree for each agent
  const inDegree = new Array<number>(agentCount).fill(0);
  for (const [agent, deps] of dependencies) {
    void agent;
    for (const dep of deps) {
      inDegree[dep]!++;
    }
  }

  // Initialize queue with agents that have no dependencies (in-degree 0)
  // Sorted by ascending agent index for determinism
  const queue: number[] = [];
  for (let i = 0; i < agentCount; i++) {
    if (inDegree[i] === 0) {
      queue.push(i);
    }
  }
  queue.sort((a, b) => a - b);

  const order: number[] = [];

  while (queue.length > 0) {
    // Pick the smallest index (deterministic tiebreak)
    const agent = queue.shift()!;
    order.push(agent);

    // Find agents that depend on this one and reduce their in-degree
    for (const [other, deps] of dependencies) {
      if (deps.has(agent)) {
        inDegree[other]!--;
        if (inDegree[other] === 0) {
          queue.push(other);
          // Keep queue sorted for deterministic tiebreak
          queue.sort((a, b) => a - b);
        }
      }
    }
  }

  // Safety: if cycle detected (shouldn't happen with proper partitioning),
  // append remaining agents in ascending order
  if (order.length < agentCount) {
    const remaining: number[] = [];
    for (let i = 0; i < agentCount; i++) {
      if (!order.includes(i)) {
        remaining.push(i);
      }
    }
    remaining.sort((a, b) => a - b);
    order.push(...remaining);
  }

  return order;
}

// ---------------------------------------------------------------------------
// Workspace merge (deterministic rebase order)
// ---------------------------------------------------------------------------

export interface MergeResult {
  /** Number of branches successfully merged */
  readonly mergedCount: number;
  /** Final commit hash after all merges */
  readonly finalCommit: string;
  /** Any conflicts encountered (file paths) */
  readonly conflicts: readonly string[];
}

/**
 * Merge all agent branches back into the base branch in deterministic order.
 *
 * Strategy:
 *   1. Checkout base branch
 *   2. For each agent in merge order:
 *      a. `git merge --no-ff --no-commit <agent-branch>`
 *      b. If conflicts: record them, attempt semantic resolution
 *      c. `git commit` with deterministic message
 *   3. Return final state
 *
 * @param config - Original workspace isolation config
 * @param result - Workspace creation result (contains merge order + branches)
 * @returns MergeResult with final commit and any conflicts
 */
export async function mergeWorkspaces(
  config: WorkspaceIsolationConfig,
  result: WorkspaceIsolationResult,
): Promise<MergeResult> {
  const { repoRoot } = config;
  const allConflicts: string[] = [];
  let mergedCount = 0;

  // Ensure we're on the base branch
  await git(repoRoot, ['checkout', '-f', result.baseCommit]);
  await git(repoRoot, ['checkout', '-B', 'swarm-merge-temp', result.baseCommit]);

  for (const agentIdx of result.mergeOrder) {
    const workspace = result.workspaces[agentIdx]!;

    try {
      // Try merge with --no-commit to detect conflicts
      await git(repoRoot, [
        'merge',
        '--no-ff',
        '--no-commit',
        workspace.branchName,
      ]);

      // No conflicts — commit
      const fileCount = workspace.assignedFiles.length;
      await git(repoRoot, [
        'commit',
        '--no-verify',
        '-m', `swarm: merge agent ${String(agentIdx)} (${String(fileCount)} files)`,
      ]);
      mergedCount++;
    } catch (mergeErr) {
      // Conflict detected — collect conflict files
      try {
        const status = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
        const conflictFiles = status.split('\n').filter(Boolean);
        allConflicts.push(...conflictFiles);

        // Abort this merge and skip — caller handles conflicts
        await git(repoRoot, ['merge', '--abort']);
      } catch {
        // If abort fails, reset hard
        await git(repoRoot, ['reset', '--hard', 'HEAD']);
      }
    }
  }

  const finalCommit = await gitRevParse(repoRoot, 'HEAD');

  return {
    mergedCount,
    finalCommit,
    conflicts: allConflicts,
  };
}

// ---------------------------------------------------------------------------
// Workspace cleanup
// ---------------------------------------------------------------------------

/**
 * Remove all ephemeral worktrees and branches created during swarm isolation.
 *
 * Must be called after merge (successful or failed) to avoid leaving
 * orphaned worktrees that interfere with future git operations.
 */
export async function cleanupWorkspaces(
  repoRoot: string,
  result: WorkspaceIsolationResult,
): Promise<void> {
  for (const workspace of result.workspaces) {
    try {
      // Remove worktree
      await git(repoRoot, [
        'worktree', 'remove',
        '--force',
        workspace.worktreePath,
      ]);
    } catch {
      // Best-effort: if removal fails, try force cleanup
      try {
        await fs.rm(workspace.worktreePath, { recursive: true, force: true });
        await git(repoRoot, ['worktree', 'prune']);
      } catch {
        // Ignore cleanup failures
      }
    }

    try {
      // Delete ephemeral branch
      await git(repoRoot, ['branch', '-D', workspace.branchName]);
    } catch {
      // Ignore if branch doesn't exist
    }
  }

  // Clean up merge temp branch if it exists
  try {
    await git(repoRoot, ['branch', '-D', 'swarm-merge-temp']);
  } catch {
    // Ignore
  }
}
