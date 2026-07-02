import { isProviderRateLimitError, type TokenUsage } from '@moonshot-ai/kosong';
import * as retry from 'retry';

import type {
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from './subagent-host';
import { isUserCancellation } from '../utils/abort';
import { PhaseTransitionLog, type PhaseTransitionSnapshot } from './typestate';

/**
 * Immutable view of a batch's execution state, passed to the launcher
 * so model resolution can be context-aware without mutating host state.
 * Uses a getter for `isRateLimited` to provide live reads of the batch's
 * internal rate-limit mode.
 */
export interface BatchExecutionContext {
  readonly batchId: string;
  readonly isRateLimited: boolean;
  readonly fallbackModel?: string;
}

/*
Subagent batch scheduling contract:
Normal phase:
- Return results in input order; empty input returns an empty list.
- Start up to 5 tasks immediately, then 1 more every 700 ms while queued work remains. By default active tasks do not cap this ramp; when KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY is set to a positive integer, the ramp additionally stops while active tasks reach that cap, and resumes as tasks complete.
- Launch priority: previous agent id saved after a rate limit, explicit resume, then new spawn.
- Readiness can be reported while the attempt is active. Ready normal launches seed the first rate-limit capacity.
- The first provider rate limit stops the ramp and enters rate-limit phase.

Rate-limit phase:
- A provider rate limit requeues while there is other unfinished work. Save the agent id for same-agent retry, emit suspended, and requeue the task at the front; its own eligibility delays are 3000 ms, 6000 ms, 12000 ms, then doubling.
- If the rate-limited attempt is the only unfinished task, fail that task instead of suspending the whole batch forever.
- Enter with capacity equal to ready normal launches, minimum 1; set the next global launch no earlier than 3000 ms later; then shrink capacity by 1, minimum 1. Later rate limits shrink by 1, minimum 1, at most once per 2000 ms.
- Each pass starts at most 1 task: active attempts must be below capacity, global launch time reached, and task eligibility reached. Choose the first eligible queued task, then set next global launch to now plus the current interval. If blocked by time or queued work remains after a launch, wake at the earlier of next launch/eligibility and next capacity recovery.
- Core recovery rule: in rate-limit phase, if work is queued and no provider rate limit happened for 3 minutes, capacity increases by 1, which can launch one more task immediately. This can happen once per quiet window; a new rate limit restarts the window. If active attempts still fill capacity, wake at the next recovery time.

Results and cancellation:
- Completed, failed, aborted, and timed-out attempts occupy their input slots; when all slots have results, return the ordered list. A task timeout fails only that task and does not enter rate-limit phase or stop others.
- The first task signal is the batch signal. User cancellation preserves existing results, marks ready or agent-known unfinished tasks aborted/started, and marks never-started tasks aborted/not_started. Non-user cancellation rejects.
*/

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;
const RATE_LIMIT_SUSPENDED_REASON = 'Provider rate limit; subagent requeued for retry.';

const AGENT_SWARM_MAX_CONCURRENCY_ENV = 'KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY';

/**
 * Heartbeat timeout: if an active attempt reports no activity for this
 * duration, the batch treats it as stalled and aborts it via the
 * AbortSignal cascade so all child resources (LLM streams, bash tasks,
 * spawned processes) are cleaned up.
 */
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

/** How often the heartbeat checker runs (every 60 seconds). */
const HEARTBEAT_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Grace period (ms) after aborting a stalled attempt before checking whether
 * the child process actually exited. If it is still alive, a zombie warning
 * is emitted.
 */
const ZOMBIE_CHECK_GRACE_MS = 10 * 1000;

/**
 * Minimal logger interface so `SubagentBatch` can emit structured warnings
 * without depending on a concrete logger implementation.
 */
interface HeartbeatLogger {
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

type BaseQueuedSubagentTask<T> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly swarmItem?: string;
  readonly runInBackground: boolean;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

export type SpawnQueuedSubagentTask<T = unknown> = BaseQueuedSubagentTask<T> & {
  readonly kind: 'spawn';
  readonly resumeAgentId?: undefined;
};

export type ResumeQueuedSubagentTask<T = unknown> = BaseQueuedSubagentTask<T> & {
  readonly kind: 'resume';
  readonly resumeAgentId: string;
};

export type QueuedSubagentTask<T = unknown> =
  | SpawnQueuedSubagentTask<T>
  | ResumeQueuedSubagentTask<T>;

export type SubagentResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted' | 'interrupted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type SubagentSuspendedEvent = {
  readonly task: QueuedSubagentTask;
  readonly agentId: string;
  readonly reason: string;
};

export type SubagentBatchLauncher = {
  spawn(options: SpawnSubagentOptions, context?: BatchExecutionContext): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions, context?: BatchExecutionContext): Promise<SubagentHandle>;
  retry(agentId: string, options: RunSubagentOptions, context?: BatchExecutionContext): Promise<SubagentHandle>;
  suspended?(event: SubagentSuspendedEvent): void;
};

type RateLimitedOutcome = {
  readonly type: 'rate_limited';
  readonly agentId: string;
  readonly error: string;
};

type AttemptOutcome<T> = SubagentResult<T> | RateLimitedOutcome;

type TaskState<T> = {
  readonly index: number;
  readonly task: QueuedSubagentTask<T>;
  agentId?: string;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
};

type ActiveAttempt<T> = {
  readonly state: TaskState<T>;
  readonly controller: AbortController;
  cleanup: () => void;
  ready: boolean;
  timedOut: boolean;
};

export type SubagentBatchOptions = {
  /**
   * Optional cap on how many subagents may run concurrently during the normal
   * phase. `undefined` means no cap (legacy ramp behavior). The rate-limit
   * phase is governed by its own capacity logic and is not affected.
   */
  readonly maxConcurrency?: number;
  readonly fallbackModel?: string;
  /**
   * Optional logger for heartbeat timeout warnings and zombie-process errors.
   * When omitted, heartbeat events are silently skipped (backward-compatible).
   */
  readonly logger?: HeartbeatLogger;
};

export class SubagentBatch<T> {
  private static nextBatchId = 0;
  private readonly batchId = `batch-${SubagentBatch.nextBatchId++}`;

  /**
   * Live read-only context for this batch. The `isRateLimited` getter
   * reads the batch's internal `rateLimitMode` at access time, providing
   * real-time state without exposing mutable internals.
   */
  public readonly context: BatchExecutionContext;

  private readonly states: Array<TaskState<T>>;
  private readonly pending: Array<TaskState<T>>;
  private readonly results: Array<SubagentResult<T> | undefined>;
  private readonly active = new Set<ActiveAttempt<T>>();
  private readonly controller = new AbortController();
  private readonly batchSignal: AbortSignal | undefined;
  private readonly batchAbortListener: () => void;
  private readonly maxConcurrency: number | undefined;
  private normalLaunchCount = 0;
  private normalLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private resolve: ((results: Array<SubagentResult<T>>) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private finished = false;
  private started = false;
  private rateLimitMode = false;
  private startedSuccessCount = 0;
  private rateLimitCapacity = 1;
  private lastRateLimitAt: number | undefined;
  private lastCapacityShrinkAt: number | undefined;
  private lastCapacityRecoveryAt: number | undefined;
  private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
  private nextRateLimitLaunchAt = 0;
  private transitionLog = new PhaseTransitionLog();

  // Heartbeat tracking: maps each active attempt's key to its last-activity
  // timestamp (epoch ms). Updated whenever the attempt reports progress.
  private readonly lastActivityMap = new Map<string, number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly logger: HeartbeatLogger | undefined;

  constructor(
    private readonly launcher: SubagentBatchLauncher,
    tasks: readonly QueuedSubagentTask<T>[],
    options: SubagentBatchOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency;
    this.logger = options.logger;
    const batch = this;
    this.context = {
      batchId: this.batchId,
      fallbackModel: options.fallbackModel,
      get isRateLimited(): boolean {
        return batch.rateLimitMode;
      },
    };
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
    }));
    this.pending = [...this.states];
    this.results = Array.from({ length: tasks.length });
    this.batchSignal = tasks.find((task) => task.signal !== undefined)?.signal;
    this.batchAbortListener = () => {
      this.controller.abort(this.batchSignal?.reason);
      if (isUserCancellation(this.batchSignal?.reason)) {
        this.finishWithUserCancellation();
      } else {
        this.fail(this.batchSignal?.reason ?? new Error('Aborted'));
      }
    };
  }

  private recordTransition(
    toPhase: 'rate_limited' | 'completed' | 'cancelled',
    trigger?: PhaseTransitionSnapshot['trigger'],
  ): void {
    const snapshot: PhaseTransitionSnapshot = {
      timestamp: Date.now(),
      fromPhase: this.rateLimitMode ? 'rate_limited' : this.finished ? 'completed' : this.started ? 'ramping' : 'idle',
      toPhase,
      trigger,
      activeAttemptCount: this.active.size,
      pendingTaskCount: this.pending.length,
    };
    this.transitionLog = this.transitionLog.record(snapshot);
  }

  /** Debug: get transition history for time-travel debugging */
  public getTransitionHistory() {
    return this.transitionLog.getHistory();
  }

  run(): Promise<Array<SubagentResult<T>>> {
    if (this.started) {
      throw new Error('SubagentBatch.run() can only be called once.');
    }
    this.started = true;

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      if (this.states.length === 0) {
        this.finish([]);
        return;
      }

      if (this.batchSignal?.aborted === true) {
        this.batchAbortListener();
        return;
      }

      this.batchSignal?.addEventListener('abort', this.batchAbortListener, { once: true });
      this.schedule();
      this.startHeartbeatTimer();
    });
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.finishIfComplete()) return;
    if (this.controller.signal.aborted) return;

    if (this.rateLimitMode) {
      this.scheduleRateLimitLaunch();
    } else {
      this.scheduleNormalLaunch();
    }
  }

  private scheduleNormalLaunch(): void {
    while (
      this.normalLaunchCount < INITIAL_LAUNCH_LIMIT &&
      this.pending.length > 0 &&
      !this.rateLimitMode &&
      !this.isAtConcurrencyLimit()
    ) {
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
    }

    if (
      this.pending.length === 0 ||
      this.rateLimitMode ||
      this.normalLaunchTimer !== undefined ||
      this.isAtConcurrencyLimit()
    ) {
      return;
    }

    this.normalLaunchTimer = setTimeout(() => {
      this.normalLaunchTimer = undefined;
      if (this.finished || this.rateLimitMode || this.pending.length === 0) return;
      if (this.isAtConcurrencyLimit()) return;
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
      this.schedule();
    }, INITIAL_LAUNCH_INTERVAL_MS);
  }

  private isAtConcurrencyLimit(): boolean {
    return this.maxConcurrency !== undefined && this.active.size >= this.maxConcurrency;
  }

  private scheduleRateLimitLaunch(): void {
    this.clearRateLimitTimer();
    if (this.pending.length === 0) return;

    const now = Date.now();
    this.recoverRateLimitCapacity(now);
    if (this.active.size >= this.rateLimitCapacity) {
      this.scheduleRateLimitWakeup(this.nextRateLimitCapacityRecoveryAt(), now);
      return;
    }

    const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.nextRateLimitCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      this.scheduleRateLimitWakeup(nextWakeupAt, now);
      return;
    }

    const pendingIndex = this.pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) return;

    const [state] = this.pending.splice(pendingIndex, 1);
    this.startAttempt(state!);
    this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
    this.scheduleNextRateLimitWakeup(now);
  }

  private startAttempt(state: TaskState<T>): void {
    if (this.finished || this.controller.signal.aborted) return;

    const attempt: ActiveAttempt<T> = {
      state,
      controller: new AbortController(),
      cleanup: () => {},
      ready: false,
      timedOut: false,
    };
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.add(attempt);
    this.lastActivityMap.set(this.attemptKey(attempt), Date.now());

    this.runAttempt(attempt).then(
      (outcome) => {
        this.handleAttemptOutcome(attempt, outcome);
      },
      (error) => {
        this.handleAttemptError(attempt, error);
      },
    );
  }

  private async runAttempt(attempt: ActiveAttempt<T>): Promise<AttemptOutcome<T>> {
    const task = attempt.state.task;
    const runOptions: RunSubagentOptions = {
      parentToolCallId: task.parentToolCallId,
      parentToolCallUuid: task.parentToolCallUuid,
      prompt: task.prompt,
      description: task.description,
      swarmIndex: task.swarmIndex,
      runInBackground: task.runInBackground,
      signal: attempt.controller.signal,
      onReady: () => {
        this.markAttemptReady(attempt);
      },
      suppressRateLimitFailureEvent: true,
    };

    let handle: SubagentHandle;
    try {
      attempt.controller.signal.throwIfAborted();
      if (attempt.state.retryAgentId !== undefined) {
        handle = await this.launcher.retry(attempt.state.retryAgentId, runOptions, this.context);
      } else if (task.kind === 'resume') {
        handle = await this.launcher.resume(task.resumeAgentId, runOptions, this.context);
      } else {
        const spawnOptions: SpawnSubagentOptions = {
          profileName: task.profileName,
          swarmItem: task.swarmItem,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions, this.context);
      }
    } catch (error) {
      return this.failedAttemptOutcome(attempt, error);
    }

    attempt.state.agentId = handle.agentId;
    try {
      const completion = await handle.completion;
      return {
        task,
        agentId: handle.agentId,
        status: 'completed',
        result: completion.result,
        usage: completion.usage,
      };
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        return {
          type: 'rate_limited',
          agentId: handle.agentId,
          error: this.attemptErrorMessage(attempt, error, 'failed'),
        };
      }

      return this.failedAttemptOutcome(attempt, error);
    }
  }

  private failedAttemptOutcome(attempt: ActiveAttempt<T>, error: unknown): SubagentResult<T> {
    const reason = attempt.controller.signal.reason;
    let status: SubagentResult<T>['status'];
    if (attempt.controller.signal.aborted && isUserCancellation(reason)) {
      status = 'aborted';
    } else if (
      attempt.controller.signal.aborted &&
      reason instanceof Error &&
      reason.message === 'heartbeat_timeout'
    ) {
      status = 'interrupted';
    } else {
      status = 'failed';
    }
    return {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status,
      state: attempt.state.agentId === undefined ? 'not_started' : 'started',
      error: this.attemptErrorMessage(attempt, error, status),
    };
  }

  private markAttemptReady(attempt: ActiveAttempt<T>): void {
    if (this.finished || attempt.ready || !this.active.has(attempt)) return;

    attempt.ready = true;
    attempt.state.started = true;
    this.lastActivityMap.set(this.attemptKey(attempt), Date.now());
    if (!this.rateLimitMode) {
      this.startedSuccessCount += 1;
    }

    if (this.rateLimitMode) {
      this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
      this.nextRateLimitLaunchAt = Date.now() + this.globalRetryIntervalMs;
      this.schedule();
    }
  }

  private handleAttemptOutcome(attempt: ActiveAttempt<T>, outcome: AttemptOutcome<T>): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;

    if ('status' in outcome) {
      this.results[attempt.state.index] = outcome;
    } else if (this.isOnlyUnfinishedTask(attempt.state)) {
      this.results[attempt.state.index] = {
        task: attempt.state.task,
        agentId: outcome.agentId,
        status: 'failed',
        state: 'started',
        error: outcome.error,
      };
    } else {
      this.requeueRateLimited(attempt, outcome.agentId);
    }
    this.schedule();
  }

  private handleAttemptError(attempt: ActiveAttempt<T>, error: unknown): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;
    this.results[attempt.state.index] = {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    this.schedule();
  }

  private releaseAttempt(attempt: ActiveAttempt<T>): boolean {
    if (!this.active.delete(attempt)) return false;
    this.lastActivityMap.delete(this.attemptKey(attempt));
    attempt.cleanup();
    return true;
  }

  private requeueRateLimited(attempt: ActiveAttempt<T>, agentId: string): void {
    const state = attempt.state;
    state.agentId = agentId;
    state.retryAgentId = agentId;
    this.launcher.suspended?.({
      task: state.task,
      agentId,
      reason: RATE_LIMIT_SUSPENDED_REASON,
    });

    const now = Date.now();
    this.lastRateLimitAt = now;
    state.retryCount += 1;
    const retryDelay = retry.createTimeout(Math.max(0, state.retryCount - 1), {
      minTimeout: RATE_LIMIT_RETRY_BASE_MS,
      maxTimeout: Number.POSITIVE_INFINITY,
      factor: RATE_LIMIT_RETRY_FACTOR,
      randomize: false,
    });
    state.retryReadyAt = now + retryDelay;
    this.pending.unshift(state);
    this.enterRateLimitMode(now);

    if (!attempt.ready) {
      this.globalRetryIntervalMs = Math.max(this.globalRetryIntervalMs * 2, retryDelay);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.globalRetryIntervalMs,
      );
    } else {
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
    }
  }

  private enterRateLimitMode(now: number): void {
    this.recordTransition('rate_limited');
    if (!this.rateLimitMode) {
      this.rateLimitMode = true;
      this.clearNormalTimer();
      this.rateLimitCapacity = Math.max(1, this.startedSuccessCount);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
      this.shrinkRateLimitCapacity(now, true);
      return;
    }

    this.shrinkRateLimitCapacity(now, false);
  }

  private shrinkRateLimitCapacity(now: number, force: boolean): void {
    if (
      !force &&
      this.lastCapacityShrinkAt !== undefined &&
      now - this.lastCapacityShrinkAt < RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
    ) {
      return;
    }

    this.rateLimitCapacity = Math.max(1, this.rateLimitCapacity - 1);
    this.lastCapacityShrinkAt = now;
  }

  private recoverRateLimitCapacity(now: number): void {
    const nextRecoveryAt = this.nextRateLimitCapacityRecoveryAt();
    if (nextRecoveryAt > now) return;

    this.rateLimitCapacity += 1;
    this.lastCapacityRecoveryAt = now;
    this.nextRateLimitLaunchAt = Math.min(this.nextRateLimitLaunchAt, now);
  }

  private nextRateLimitCapacityRecoveryAt(): number {
    if (this.pending.length === 0 || this.lastRateLimitAt === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    const latestCapacityChangeAt = Math.max(
      this.lastRateLimitAt,
      this.lastCapacityRecoveryAt ?? 0,
    );
    return latestCapacityChangeAt + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
  }

  private scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
    this.rateLimitLaunchTimer = setTimeout(() => {
      this.rateLimitLaunchTimer = undefined;
      this.schedule();
    }, wakeupAt - now);
  }

  private scheduleNextRateLimitWakeup(now: number): void {
    if (this.pending.length === 0) return;

    const nextWakeupAt =
      this.active.size >= this.rateLimitCapacity
        ? this.nextRateLimitCapacityRecoveryAt()
        : Math.min(
            Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt()),
            this.nextRateLimitCapacityRecoveryAt(),
          );

    this.scheduleRateLimitWakeup(nextWakeupAt, now);
  }

  private nextPendingReadyAt(): number {
    return this.pending.reduce((nextAt, state) => {
      return Math.min(nextAt, state.retryReadyAt);
    }, Number.POSITIVE_INFINITY);
  }

  private finishIfComplete(): boolean {
    if (this.results.every((result) => result !== undefined)) {
      this.finish(this.results);
      return true;
    }
    return false;
  }

  private isOnlyUnfinishedTask(state: TaskState<T>): boolean {
    return this.results.every((result, index) => index === state.index || result !== undefined);
  }

  private finishWithUserCancellation(): void {
    if (this.finished) return;
    this.recordTransition('cancelled');

    // Abort every in-progress attempt so the full signal cascade fires
    // (child TurnFlow, BackgroundManager, spawned processes).
    for (const attempt of this.active.values()) {
      if (!attempt.controller.signal.aborted) {
        attempt.controller.abort(new Error('Subagent batch cancelled by user'));
      }
    }

    this.finish(
      this.states.map((state) => {
        const result = this.results[state.index];
        if (result !== undefined) return result;

        if (state.started || state.agentId !== undefined) {
          return {
            task: state.task,
            agentId: state.agentId,
            status: 'aborted',
            state: 'started',
            error:
              'The user manually interrupted this subagent batch before this subagent finished.',
          };
        }

        return {
          task: state.task,
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        };
      }),
    );
  }

  private finish(results: Array<SubagentResult<T>>): void {
    if (this.finished) return;
    this.recordTransition('completed');
    this.finished = true;
    this.cleanup();
    this.resolve?.(results);
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.reject?.(error);
  }

  private cleanup(): void {
    this.batchSignal?.removeEventListener('abort', this.batchAbortListener);
    this.clearNormalTimer();
    this.clearRateLimitTimer();
    this.clearHeartbeatTimer();
    for (const attempt of this.active.values()) {
      attempt.cleanup();
    }
    this.active.clear();
    this.lastActivityMap.clear();
  }

  private clearNormalTimer(): void {
    if (this.normalLaunchTimer !== undefined) clearTimeout(this.normalLaunchTimer);
    this.normalLaunchTimer = undefined;
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitLaunchTimer !== undefined) clearTimeout(this.rateLimitLaunchTimer);
    this.rateLimitLaunchTimer = undefined;
  }

  // ── Heartbeat tracking ──────────────────────────────────────────────

  /** Stable key for an active attempt (used as Map key in lastActivityMap). */
  private attemptKey(attempt: ActiveAttempt<T>): string {
    return `${this.batchId}::${attempt.state.index}::${attempt.state.agentId ?? 'pending'}`;
  }

  private startHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeats();
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * Scan all active attempts. Any attempt whose last-activity timestamp is
   * older than `HEARTBEAT_TIMEOUT_MS` is aborted via its controller, which
   * cascades through the AbortSignal chain to kill the child agent's LLM
   * stream, background tasks, and spawned processes.
   */
  private checkHeartbeats(): void {
    if (this.finished || this.controller.signal.aborted) return;

    const now = Date.now();
    for (const attempt of this.active) {
      const key = this.attemptKey(attempt);
      const lastActivity = this.lastActivityMap.get(key);
      if (lastActivity === undefined) continue;

      if (now - lastActivity > HEARTBEAT_TIMEOUT_MS) {
        const agentId = attempt.state.agentId;
        this.logger?.warn('subagent_heartbeat_timeout', {
          agentId,
          lastActivity,
          batchId: this.batchId,
          stalledMs: now - lastActivity,
        });

        // Abort via the attempt controller. The signal propagates through
        // SessionSubagentHost.runWithActiveChild() → linkAbortSignal →
        // child controller → TurnFlow.activeTurn.controller → LLM stream
        // cancel → BackgroundManager.cancelAll() → SIGTERM/SIGKILL.
        attempt.controller.abort(new Error('heartbeat_timeout'));

        // Schedule a zombie-process check after a short grace period.
        this.scheduleZombieCheck(attempt, agentId);
      }
    }
  }

  /**
   * After aborting a stalled attempt, wait a grace period and then verify
   * the child process exited. This is a best-effort diagnostic — in-process
   * agents may not have PIDs to check, so we only log when we can detect
   * a lingering process.
   */
  private scheduleZombieCheck(attempt: ActiveAttempt<T>, agentId: string | undefined): void {
    const key = this.attemptKey(attempt);
    setTimeout(() => {
      // If the attempt is still in the active set after the grace period,
      // it has not been collected by releaseAttempt yet — possible zombie.
      if (this.active.has(attempt) && !attempt.controller.signal.aborted) {
        this.logger?.error('zombie_process_detected', {
          agentId,
          batchId: this.batchId,
          message:
            'Attempt was aborted by heartbeat but the controller is still active after grace period.',
        });
      }
      this.lastActivityMap.delete(key);
    }, ZOMBIE_CHECK_GRACE_MS);
  }

  private linkAttemptSignals(attempt: ActiveAttempt<T>, task: QueuedSubagentTask<T>): () => void {
    const abortFromBatch = () => {
      attempt.controller.abort(this.controller.signal.reason);
    };
    const abortFromTask = () => {
      attempt.controller.abort(task.signal?.reason);
    };
    const timeout =
      task.timeout === undefined
        ? undefined
        : setTimeout(() => {
            attempt.timedOut = true;
            attempt.controller.abort(new Error('Aborted'));
          }, task.timeout);

    if (this.controller.signal.aborted) {
      abortFromBatch();
    } else if (task.signal?.aborted === true) {
      abortFromTask();
    } else {
      this.controller.signal.addEventListener('abort', abortFromBatch, { once: true });
      task.signal?.addEventListener('abort', abortFromTask, { once: true });
    }

    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      this.controller.signal.removeEventListener('abort', abortFromBatch);
      task.signal?.removeEventListener('abort', abortFromTask);
    };
  }

  private attemptErrorMessage(
    attempt: ActiveAttempt<T>,
    error: unknown,
    status: SubagentResult<T>['status'],
  ): string {
    if (attempt.timedOut && attempt.state.task.timeout !== undefined) {
      return 'Subagent timed out.';
    }
    if (status === 'aborted') return 'The user manually interrupted this subagent batch.';
    if (status === 'interrupted') return 'Subagent heartbeat timeout; the attempt was stalled and aborted.';
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Resolve the optional AgentSwarm normal-phase concurrency cap from the environment.
 *
 * Returns `undefined` when the variable is unset/empty. A present value must be a
 * positive integer; invalid input fails fast so a misconfigured cap never silently
 * reverts to the uncapped ramp.
 */
export function resolveSwarmMaxConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  const raw = env[AGENT_SWARM_MAX_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${AGENT_SWARM_MAX_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}
