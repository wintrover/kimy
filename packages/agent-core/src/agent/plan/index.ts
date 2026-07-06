import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Agent } from '..';
import { generateHeroSlug } from '../../utils/hero-slug';

export type PlanData = null | {
  id: string;
  content: string;
  path: string;
};
export type PlanFilePath = string | null;

// ── Plan transition state machine ────────────────────────────────────

export const PlanTransitionState = {
  IDLE: 'idle',
  PLAN_SAVED: 'plan_saved',
} as const;

export type PlanTransitionState = typeof PlanTransitionState[keyof typeof PlanTransitionState];

export const PlanTransition = {
  IDLE_TO_PLAN_SAVED: 'IDLE_TO_PLAN_SAVED',
  PLAN_SAVED_TO_IDLE: 'PLAN_SAVED_TO_IDLE',
  PLAN_SAVED_TO_RESUME_EXHAUSTED: 'PLAN_SAVED_TO_RESUME_EXHAUSTED',
  PLAN_SAVED_TO_MICRO_RESUME: 'PLAN_SAVED_TO_MICRO_RESUME',
  PLAN_SAVED_TO_IDLE_FORCED: 'PLAN_SAVED_TO_IDLE_FORCED',
  PLAN_SAVED_TO_SAFETY_RESET: 'PLAN_SAVED_TO_SAFETY_RESET',
} as const;

export type PlanTransition = typeof PlanTransition[keyof typeof PlanTransition];

export interface PlanTransitionEvent {
  transition: PlanTransition;
  source: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class PlanMode {
  protected _isActive = false;
  protected _planId: null | string = null;
  protected _planFilePath: PlanFilePath = null;

  private static readonly PLANS_DIR = 'plans';
  private static readonly GC_TIMESTAMP_FILE = '.last-gc-check';
  private static readonly GC_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static readonly PLAN_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  private static readonly MAX_WRITE_RETRIES = 3;

  private _transitionState: PlanTransitionState = PlanTransitionState.IDLE;
  private _planResumeAttempts = 0;
  static readonly MAX_PLAN_RESUME_ATTEMPTS = 2;

  private getPlansDir(): string {
    return join(
      this.planDir ?? this.agent.homedir ?? this.agent.config.cwd,
      PlanMode.PLANS_DIR,
    );
  }

  constructor(
    protected readonly agent: Agent,
    private readonly planDir?: string,
  ) {}

  /**
   * Post-await guard: check that PlanMode is still active after an async operation.
   * Returns false if exit() or cancel() deactivated the mode during the await.
   */
  private assertActive(operation: string): boolean {
    if (!this._isActive) {
      this.agent.log?.info('plan_operation_interrupted', { operation });
      return false;
    }
    return true;
  }

  async createPlanId(): Promise<string> {
    const existing = await this.collectExistingSlugs(this.getPlansDir());
    return generateHeroSlug(randomUUID(), existing);
  }

  private async collectExistingSlugs(dir: string): Promise<Set<string>> {
    const slugs = new Set<string>();
    try {
      for await (const entry of this.agent.kaos.iterdir(dir)) {
        if (entry.endsWith('.md')) {
          slugs.add(entry.slice(0, -3));
        }
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        // ENOENT — directory doesn't exist yet or was deleted; safe to proceed with empty set
        return slugs;
      }
      const code = (error as { readonly code?: string }).code;
      if (code === 'EACCES' || code === 'EPERM') {
        this.agent.log?.warn('PlanMode: permission denied reading plans directory', { dir, code });
        return slugs;
      }
      // Unexpected errors — rethrow so they surface in development
      throw error;
    }
    return slugs;
  }

  private async maybeRunGC(): Promise<void> {
    const plansDir = this.getPlansDir();
    const gcFile = join(plansDir, PlanMode.GC_TIMESTAMP_FILE);

    try {
      const stat = await this.agent.kaos.stat(gcFile);
      if (Date.now() - stat.stMtime * 1000 < PlanMode.GC_THRESHOLD_MS) return;
    } catch (error) {
      if (isMissingFileError(error)) {
        // File doesn't exist — first run, proceed with GC
      } else {
        this.agent.log?.warn('PlanMode: GC timestamp file unreadable, forcing GC', { error });
      }
    }

    await this.runGC(plansDir);
    await this.ensurePlanDirectory(gcFile);
    await this.agent.kaos.writeText(gcFile, new Date().toISOString());
  }

  private async runGC(dir: string): Promise<void> {
    const now = Date.now();
    const staleThreshold = PlanMode.PLAN_STALE_MS;

    try {
      for await (const entry of this.agent.kaos.iterdir(dir)) {
        if (!entry.endsWith('.md')) continue;
        const filePath = join(dir, entry);
        try {
          const stat = await this.agent.kaos.stat(filePath);
          const age = now - stat.stMtime * 1000;
          if (age > staleThreshold) {
            this.agent.log?.info('PlanMode: stale plan file detected', { file: entry, ageDays: age / 86400000 | 0 });
          }
        } catch {
          // file may have been deleted between iterdir and stat — safe to skip
        }
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        // ENOENT — directory doesn't exist yet; nothing to GC
        return;
      }
      throw error;
    }
  }

  async enter(id?: string, createFile = false, emitStatus = true): Promise<void> {
    if (id === undefined) {
      id = await this.createPlanId();
    }
    await this.maybeRunGC();
    if (this._isActive) {
      throw new Error('Already in plan mode');
    }

    this._isActive = true;
    this._planId = id;
    this._planFilePath = null;

    let enterRecorded = false;
    try {
      const planFilePath = this.planFilePathFor(id);
      this._planFilePath = planFilePath;
      await this.ensurePlanDirectory(planFilePath);
      if (!this.assertActive('ensurePlanDirectory')) return;
      this.agent.records.logRecord({ type: 'plan_mode.enter', id });
      enterRecorded = true;
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
        if (!this.assertActive('writeEmptyPlanFile')) return;
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      } else {
        this._isActive = false;
        this._planId = null;
        this._planFilePath = null;
      }
      throw error;
    }

    if (emitStatus) this.agent.emitStatusUpdated();
  }

  restoreEnter({ id }: { readonly id: string }): void {
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: true,
    });

    this._isActive = true;
    this._planId = id;
    this._planFilePath = this.planFilePathFor(id);
  }

  cancel(id?: string): void {
    try {
      this.agent.records.logRecord({ type: 'plan_mode.cancel', id });
      this.agent.replayBuilder.push({
        type: 'plan_updated',
        enabled: false,
      });
      this._isActive = false;
      this._planId = null;
      this._planFilePath = null;
      this.agent.emitStatusUpdated();
    } finally {
      try {
        if (this._transitionState !== PlanTransitionState.IDLE) {
          this.clearTransitionState(PlanTransition.PLAN_SAVED_TO_IDLE, 'plan_mode.cancel.forced_cleanup');
        }
      } catch (cleanupError) {
        this._transitionState = PlanTransitionState.IDLE;
        this._planResumeAttempts = 0;
        this.agent.log?.error?.('plan_cancel_cleanup_failed', { error: cleanupError });
      }
      this._planResumeAttempts = 0;
    }
  }

  async clear(): Promise<void> {
    if (!this._planFilePath) return;
    await this.writeEmptyPlanFile(this._planFilePath);
  }

  exit(id?: string): void {
    try {
      this.agent.records.logRecord({ type: 'plan_mode.exit', id });
      this.agent.replayBuilder.push({
        type: 'plan_updated',
        enabled: false,
      });
      this._isActive = false;
      this._planId = null;
      this._planFilePath = null;
      this.agent.emitStatusUpdated();
    } finally {
      try {
        if (this._transitionState !== PlanTransitionState.IDLE) {
          this.clearTransitionState(PlanTransition.PLAN_SAVED_TO_IDLE, 'plan_mode.exit.forced_cleanup');
        }
      } catch (cleanupError) {
        this._transitionState = PlanTransitionState.IDLE;
        this._planResumeAttempts = 0;
        this.agent.log?.error?.('plan_exit_cleanup_failed', { error: cleanupError });
      }
      this._planResumeAttempts = 0;
    }
  }

  get isActive() {
    return this._isActive;
  }

  get planFilePath(): PlanFilePath {
    return this._planFilePath;
  }

  get plansDir(): string {
    return this.getPlansDir();
  }

  async data(): Promise<PlanData> {
    if (!this._planId || !this._planFilePath) return null;
    let content = '';
    try {
      content = await this.agent.kaos.readText(this._planFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: this._planId,
      content,
      path: this._planFilePath,
    };
  }

  get transitionState(): PlanTransitionState { return this._transitionState; }

  markPlanSaved(source: string): void {
    this._transitionState = PlanTransitionState.PLAN_SAVED;
    this._planResumeAttempts = 0;
    this.emitTransition({
      transition: PlanTransition.IDLE_TO_PLAN_SAVED,
      source,
      timestamp: Date.now(),
      metadata: { planId: this._planId, planFilePath: this._planFilePath },
    });
  }

  clearTransitionState(transition: PlanTransition, source: string): void {
    this._transitionState = PlanTransitionState.IDLE;
    this.emitTransition({
      transition,
      source,
      timestamp: Date.now(),
      metadata: { planId: this._planId, resumeAttempts: this._planResumeAttempts },
    });
    this._planResumeAttempts = 0;
  }

  incrementResumeAttempts(): number {
    return ++this._planResumeAttempts;
  }

  private emitTransition(event: PlanTransitionEvent): void {
    this.agent.log?.info('plan_transition', event);
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.agent.kaos.writeText(path, '');
  }

  private async writePlanWithRetry(content: string): Promise<{ id: string; path: string }> {
    for (let attempt = 0; attempt < PlanMode.MAX_WRITE_RETRIES; attempt++) {
      const id = await this.createPlanId();
      const path = this.planFilePathFor(id);

      // Check if file already exists (stat-before-write pattern)
      try {
        await this.agent.kaos.stat(path);
        // File exists — collision, retry with new ID
        this.agent.log?.info('PlanMode: plan file collision detected, retrying', { attempt: attempt + 1, path });
        continue;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        // ENOENT — file doesn't exist, safe to proceed
      }

      await this.ensurePlanDirectory(path);
      await this.agent.kaos.writeText(path, content);
      return { id, path };
    }
    throw new Error('Failed to create plan file: too many collisions after retries');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.agent.kaos.mkdir(dirname(path), {
      parents: true,
      existOk: true,
    });
  }

  private planFilePathFor(id: string): string {
    return join(this.getPlansDir(), `${id}.md`);
  }
}

function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}
