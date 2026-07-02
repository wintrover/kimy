/**
 * Typestate pattern for SubagentBatch phase management.
 *
 * Uses TypeScript discriminated unions to make invalid phase transitions
 * compile-time errors rather than runtime assertions.
 *
 * Each PhaseContext variant carries only the data relevant to that phase,
 * enforced by the generic parameter P.
 */

/** Batch execution phases — discriminant for the typestate union */
export type BatchPhase = 'idle' | 'ramping' | 'rate_limited' | 'draining' | 'completed' | 'cancelled';

/** Phase-specific context — the discriminant makes narrowing automatic */
export type PhaseContext<P extends BatchPhase = BatchPhase> =
  | { readonly _phase: 'idle' }
  | { readonly _phase: 'ramping'; readonly normalLaunchCount: number; readonly startedSuccessCount: number }
  | { readonly _phase: 'rate_limited'; readonly rateLimitCapacity: number; readonly lastRateLimitAt: number; readonly globalRetryIntervalMs: number; readonly nextRateLimitLaunchAt: number }
  | { readonly _phase: 'draining'; readonly activeAttemptCount: number }
  | { readonly _phase: 'completed' }
  | { readonly _phase: 'cancelled' };

// ── Pure transition functions (no side effects) ──────────────────

/** idle or ramping → rate_limited */
export function toRateLimited(
  ctx: PhaseContext<'idle'> | PhaseContext<'ramping'>,
  now: number,
  startedSuccessCount: number,
): PhaseContext<'rate_limited'> {
  return {
    _phase: 'rate_limited',
    rateLimitCapacity: Math.max(1, startedSuccessCount),
    lastRateLimitAt: now,
    globalRetryIntervalMs: 3000,
    nextRateLimitLaunchAt: now + 3000,
  };
}

/** idle → ramping */
export function toRamping(normalLaunchCount: number, startedSuccessCount: number): PhaseContext<'ramping'> {
  return { _phase: 'ramping', normalLaunchCount, startedSuccessCount };
}

/** any → completed */
export function toCompleted(): PhaseContext<'completed'> {
  return { _phase: 'completed' };
}

/** any → cancelled */
export function toCancelled(): PhaseContext<'cancelled'> {
  return { _phase: 'cancelled' };
}

// ── Phase Transition Log (Time-Travel Debugging) ─────────────────

/** Immutable snapshot of a single phase transition */
export interface PhaseTransitionSnapshot {
  readonly timestamp: number;
  readonly fromPhase: BatchPhase;
  readonly toPhase: BatchPhase;
  /** Error that triggered the transition (if any) */
  readonly trigger?: {
    readonly errorType: string;
    readonly providerId?: string;
    readonly statusCode?: number;
  };
  /** Async debugging: snapshot of timers/active work at transition time */
  readonly activeAttemptCount: number;
  readonly pendingTaskCount: number;
}

/** Append-only immutable transition history log */
export class PhaseTransitionLog {
  private readonly history: ReadonlyArray<PhaseTransitionSnapshot> = [];

  /** Record a new snapshot and return the expanded log (immutable) */
  record(snapshot: PhaseTransitionSnapshot): PhaseTransitionLog {
    const next = new PhaseTransitionLog();
    (next as any).history = [...this.history, snapshot];
    return next;
  }

  /** Full history (read-only) */
  getHistory(): ReadonlyArray<PhaseTransitionSnapshot> {
    return this.history;
  }

  /** Snapshots since a given timestamp (race-condition analysis) */
  getSince(timestamp: number): ReadonlyArray<PhaseTransitionSnapshot> {
    return this.history.filter((s) => s.timestamp >= timestamp);
  }

  /** Last N snapshots */
  getRecent(count: number): ReadonlyArray<PhaseTransitionSnapshot> {
    return this.history.slice(-count);
  }

  /** Serialize for deterministic replay */
  serialize(): string {
    return JSON.stringify(this.history, null, 2);
  }
}
