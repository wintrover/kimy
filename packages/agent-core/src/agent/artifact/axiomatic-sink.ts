/**
 * AxiomaticFileSink — Immutable store + atomic symlink swap.
 *
 * Nix-inspired architecture:
 * 1. Build complete file tree in immutable store (.axiom/store/<commit_id>/)
 * 2. Verify all checksums
 * 3. Create relative symlink
 * 4. Single atomic rename to swap pointer
 *
 * Guarantees:
 * - Crash safety: failure before swap = zero corruption (S₀ preserved)
 * - EXDEV safe: all operations within same .axiom/ directory
 * - Durability: fsync on files AND parent directories
 * - Portability: relative symlinks survive directory moves
 */

import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import type { CASManifest } from './cas-manifest';

// ── Types ─────────────────────────────────────────────────────────────────

export interface CommitResult {
  readonly success: boolean;
  readonly commitId?: string;
  readonly error?: string;
}

// ── AxiomaticFileSink ─────────────────────────────────────────────────────

export class AxiomaticFileSink {
  /**
   * Commit a CAS manifest to the immutable store with atomic symlink swap.
   *
   * State transition: S₀ → S₁ via single rename() system call.
   * If any step fails before the swap, S₀ is completely untouched.
   */
  async commit(cas: CASManifest, baseDir: string): Promise<CommitResult> {
    const axiomDir = join(baseDir, '.axiom');
    const storeDir = join(axiomDir, 'store', cas.commit_id);
    const currentLink = join(axiomDir, 'current');
    const nextLinkTmp = join(axiomDir, `current.next.${cas.commit_id}`);

    try {
      // Step 1: Build immutable tree in isolated store
      await mkdir(storeDir, { recursive: true });

      const activeDirectories = new Set<string>();
      activeDirectories.add(storeDir);

      for (const entry of cas.manifest) {
        const content = cas.blobs[entry.hash];
        if (content === undefined) {
          throw new Error(`Missing blob for hash ${entry.hash} (path: ${entry.path})`);
        }

        // Verify content hash
        const actualHash = createHash('sha256').update(content).digest('hex');
        if (actualHash !== entry.hash) {
          throw new Error(
            `Hash mismatch for ${entry.path}: expected ${entry.hash}, got ${actualHash}`,
          );
        }

        const filePath = join(storeDir, entry.path);
        const fileDir = dirname(filePath);

        await mkdir(fileDir, { recursive: true });
        activeDirectories.add(fileDir);

        await writeFileWithFsync(filePath, content, entry.mode ?? 0o644);
      }

      // Step 2: Flush all parent directory metadata (POSIX requirement)
      for (const dir of activeDirectories) {
        await flushDirectoryMetadata(dir);
      }

      // Step 3: Create relative symlink (portable across directory moves)
      // .axiom/current → store/<commit_id>
      const relativeTarget = join('store', cas.commit_id);
      await symlink(relativeTarget, nextLinkTmp, 'dir');
      await flushDirectoryMetadata(axiomDir);

      // Step 4: CRITICAL POINT — single rename() for atomic pointer swap
      await rename(nextLinkTmp, currentLink);
      await flushDirectoryMetadata(axiomDir);

      return { success: true, commitId: cas.commit_id };
    } catch (error) {
      // Failure before swap: S₀ is untouched, just clean up debris
      await safeCleanup(storeDir, nextLinkTmp);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Read the current commit_id from the symlink target.
   * Returns null if no current generation exists.
   */
  async getCurrentCommitId(baseDir: string): Promise<string | null> {
    try {
      const { readlink } = await import('node:fs/promises');
      const currentLink = join(baseDir, '.axiom', 'current');
      const target = await readlink(currentLink);
      if (target === undefined) return null;
      // target is "store/<commit_id>", extract commit_id
      const parts = target.split('/');
      return parts.length >= 2 ? (parts.at(-1) ?? null) : null;
    } catch {
      return null;
    }
  }
}

// ── File I/O Helpers ──────────────────────────────────────────────────────

/**
 * Write file with explicit fsync for durability guarantee.
 * Ensures data is flushed from OS buffer cache to physical storage.
 */
async function writeFileWithFsync(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const handle = await open(filePath, 'w', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flush directory metadata (inode entry parent mapping) to disk.
 *
 * POSIX requirement: after creating/modifying files in a directory,
 * the directory's metadata must be fsync'd to ensure the filename→inode
 * mapping is persisted. Without this, a power failure can cause files
 * to "vanish" even though their data was flushed.
 */
async function flushDirectoryMetadata(dirPath: string): Promise<void> {
  let dirHandle;
  try {
    dirHandle = await open(dirPath, 'r');
    await dirHandle.sync();
  } catch {
    // Silently ignore on platforms where directory sync is not supported
  } finally {
    if (dirHandle) await dirHandle.close();
  }
}

/**
 * Safe cleanup: remove store directory and temporary symlink.
 * Errors are silently ignored to avoid masking the original failure.
 */
async function safeCleanup(storeDir: string, tmpLink: string): Promise<void> {
  try {
    await rm(storeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    await rm(tmpLink, { force: true });
  } catch {
    /* ignore */
  }
}
