/**
 * Checkpoint Recovery — Generation-based rollback for Axiomatic Artifact Protocol.
 *
 * Leverages the immutable store's generation history:
 * - Each commit creates a new generation in .axiom/store/<commit_id>/
 * - Rollback = point current symlink to a previous generation
 * - No data copying needed — generations are preserved in the store
 */

import { readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'pathe';

import type { CASManifest } from './cas-manifest';
import { createCASManifest } from './cas-manifest';
import { AxiomaticFileSink, type CommitResult } from './axiomatic-sink';

// ── CheckpointRecovery ────────────────────────────────────────────────────

export class CheckpointRecovery {
  private readonly checkpoints = new Map<string, CASManifest>();

  /**
   * Save a checkpoint (before filesystem commit).
   * Checkpoints are kept in memory for the session lifetime.
   */
  saveCheckpoint(id: string, cas: CASManifest): void {
    this.checkpoints.set(id, cas);
  }

  /**
   * Recover from a checkpoint by committing it to the store.
   */
  async recover(id: string, baseDir: string): Promise<CommitResult> {
    const cas = this.checkpoints.get(id);
    if (cas === undefined) {
      return { success: false, error: `Checkpoint ${id} not found` };
    }

    const sink = new AxiomaticFileSink();
    return sink.commit(cas, baseDir);
  }

  /**
   * Rollback to a previous generation by swapping the current symlink.
   *
   * This is O(1) — just a single rename() call.
   * No data copying needed because all generations are preserved in the store.
   */
  async rollback(previousCommitId: string, baseDir: string): Promise<CommitResult> {
    const axiomDir = join(baseDir, '.axiom');
    const storeDir = join(axiomDir, 'store', previousCommitId);
    const currentLink = join(axiomDir, 'current');
    const nextLinkTmp = join(axiomDir, `current.next.${previousCommitId}`);

    try {
      // Verify the previous generation exists
      await readdir(storeDir);

      // Create relative symlink and atomic swap
      const relativeTarget = join('store', previousCommitId);
      await symlink(relativeTarget, nextLinkTmp, 'dir');
      await rename(nextLinkTmp, currentLink);

      return { success: true, commitId: previousCommitId };
    } catch (error) {
      await safeCleanup(nextLinkTmp);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the current generation's commit_id.
   */
  async getCurrentCommitId(baseDir: string): Promise<string | null> {
    try {
      const currentLink = join(baseDir, '.axiom', 'current');
      const target = await readlink(currentLink);
      if (target === undefined) return null;
      const parts = target.split('/');
      return parts.length >= 2 ? (parts.at(-1) ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * List all available generations in the store.
   */
  async listGenerations(baseDir: string): Promise<string[]> {
    try {
      const storeDir = join(baseDir, '.axiom', 'store');
      const entries = await readdir(storeDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .toSorted();
    } catch {
      return [];
    }
  }
}

// ── Apply Artifact ────────────────────────────────────────────────────────

/**
 * Apply an artifact to the filesystem using the Axiomatic Artifact Protocol.
 *
 * Flow:
 * 1. Convert artifact to CAS manifest (deterministic)
 * 2. Save checkpoint for potential recovery
 * 3. Commit via AxiomaticFileSink (immutable store + atomic swap)
 *
 * Note: No explicit rollback is needed on failure.
 * The atomic swap architecture guarantees that S₀ (current state) is
 * completely untouched if any step before the swap fails.
 */
export async function applyArtifact(
  artifact: { artifacts: Array<{ path: string; content: string }> },
  baseDir: string,
): Promise<CommitResult> {
  const cas = createCASManifest(artifact.artifacts);
  const recovery = new CheckpointRecovery();

  // Save checkpoint (for session-level recovery, not for automatic rollback)
  recovery.saveCheckpoint(cas.commit_id, cas);

  const sink = new AxiomaticFileSink();
  const result = await sink.commit(cas, baseDir);

  if (!result.success) {
    // No rollback needed: swap never happened, S₀ is intact
    throw new Error(`Artifact commit failed safely without corruption: ${result.error}`);
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function safeCleanup(tmpLink: string): Promise<void> {
  try {
    await rm(tmpLink, { force: true });
  } catch {
    /* ignore */
  }
}
