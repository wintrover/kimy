/**
 * OrchestratorLock — file ownership allocation for concurrent agents.
 *
 * When multiple sub-agents work on the same repository, the lock ensures that
 * no two agents touch the same file. Each agent reserves its intended files
 * before execution, and after committing the lock verifies that no ownership
 * violations occurred.
 */

export interface FileViolation {
  readonly file: string;
  readonly owner: string;
  readonly claimant: string;
}

export interface PostCommitResult {
  readonly ok: boolean;
  readonly violations: readonly FileViolation[];
}

export class OrchestratorLock {
  private readonly ownership = new Map<string, string>(); // filePath → agentId

  /**
   * Reserve files for an agent before execution begins.
   *
   * Returns `{ ok: true }` if all files were successfully reserved, or
   * `{ ok: false, conflicts }` listing files already owned by another agent.
   */
  reserve(agentId: string, files: string[]): { ok: boolean; conflicts: string[] } {
    const conflicts: string[] = [];
    for (const f of files) {
      const existing = this.ownership.get(f);
      if (existing !== undefined && existing !== agentId) {
        conflicts.push(f);
      }
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    for (const f of files) this.ownership.set(f, agentId);
    return { ok: true, conflicts: [] };
  }

  /**
   * Verify that an agent only touched files it owns.
   *
   * Called after the agent reports which files it changed and the actual disk
   * changes have been captured.
   */
  verifyPostCommit(agentId: string, actualFiles: string[]): PostCommitResult {
    const violations: FileViolation[] = [];
    for (const f of actualFiles) {
      const owner = this.ownership.get(f);
      if (owner !== undefined && owner !== agentId) {
        violations.push({ file: f, owner, claimant: agentId });
      }
    }
    return { ok: violations.length === 0, violations };
  }

  /**
   * Release all files owned by an agent.
   *
   * Called during cleanup after a transaction completes (commit or rollback).
   */
  release(agentId: string): void {
    for (const [file, owner] of this.ownership) {
      if (owner === agentId) this.ownership.delete(file);
    }
  }
}
