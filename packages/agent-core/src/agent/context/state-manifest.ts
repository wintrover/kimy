export interface CompletedTask {
  taskId: string;
  summary: string;
  status: 'success' | 'failure' | 'partial';
}

export interface ActiveTask {
  taskId: string;
  description: string;
  startedAt: number;
}

export const MANIFEST_LIMITS = {
  maxCompletedTasks: 50,
  maxKeyFindings: 20,
  maxAffectedFiles: 100,
  maxIssues: 10,
  maxSummaryLength: 200,
} as const;

export class StateManifest {
  readonly completedTasks = new Map<string, CompletedTask>();
  readonly activeTasks = new Map<string, ActiveTask>();
  readonly keyFindings: string[] = [];
  readonly affectedFiles: string[] = [];
  readonly issues: string[] = [];
  readonly todoSnapshot: string[] = [];
  lastUpdatedAt = 0;

  private updateQueue: Promise<void> = Promise.resolve();

  /**
   * Mutex-guarded atomic update.
   * Multiple subagents completing simultaneously are serialized.
   */
  async atomicUpdate(updater: (manifest: this) => void): Promise<void> {
    this.updateQueue = this.updateQueue.then(() => {
      updater(this);
      this.lastUpdatedAt = Date.now();
    });
    await this.updateQueue;
  }

  /**
   * Synchronous version (when already in a single-threaded context).
   * JS event loop guarantees no race within synchronous functions.
   */
  update(updater: (manifest: this) => void): void {
    updater(this);
    this.lastUpdatedAt = Date.now();
  }

  addKeyFinding(finding: string): void {
    if (this.keyFindings.length >= MANIFEST_LIMITS.maxKeyFindings) {
      this.keyFindings.shift();
    }
    this.keyFindings.push(finding);
  }

  addAffectedFile(file: string): void {
    if (this.affectedFiles.includes(file)) return;
    if (this.affectedFiles.length >= MANIFEST_LIMITS.maxAffectedFiles) {
      this.affectedFiles.shift();
    }
    this.affectedFiles.push(file);
  }

  addIssue(issue: string): void {
    if (this.issues.length >= MANIFEST_LIMITS.maxIssues) {
      this.issues.shift();
    }
    this.issues.push(issue);
  }

  toPromptString(): string {
    const parts: string[] = [];
    if (this.completedTasks.size > 0) {
      parts.push('## Completed Tasks');
      for (const task of this.completedTasks.values()) {
        parts.push(`- [${task.status}] ${task.taskId}: ${task.summary}`);
      }
    }
    if (this.activeTasks.size > 0) {
      parts.push('## Active Tasks');
      for (const task of this.activeTasks.values()) {
        parts.push(`- ${task.taskId}: ${task.description}`);
      }
    }
    if (this.keyFindings.length > 0) {
      parts.push('## Key Findings');
      for (const f of this.keyFindings) parts.push(`- ${f}`);
    }
    if (this.affectedFiles.length > 0) {
      parts.push('## Affected Files');
      for (const f of this.affectedFiles) parts.push(`- ${f}`);
    }
    if (this.issues.length > 0) {
      parts.push('## Issues');
      for (const i of this.issues) parts.push(`- ${i}`);
    }
    return parts.join('\n');
  }

  clear(): void {
    this.completedTasks.clear();
    this.activeTasks.clear();
    this.keyFindings.length = 0;
    this.affectedFiles.length = 0;
    this.issues.length = 0;
    this.todoSnapshot.length = 0;
    this.lastUpdatedAt = 0;
  }
}
