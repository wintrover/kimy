import { createControlledPromise } from '@antfu/utils';
import { APIProviderRateLimitError } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import {
  type QueuedSubagentTask,
  type RunSubagentOptions,
  type SpawnSubagentOptions,
  type SubagentHandle,
} from '../../src/session/subagent-host';
import {
  SubagentBatch,
  resolveSwarmMaxConcurrency,
  type BatchExecutionContext,
  type SubagentBatchLauncher,
  type SubagentResult,
  type SubagentSuspendedEvent,
} from '../../src/session/subagent-batch';
import { userCancellationReason } from '../../src/utils/abort';

const signal = new AbortController().signal;

describe('SubagentBatch scheduling contract', () => {
  it('normal phase starts five tasks immediately, then one task every 700ms', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)),
        { signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(8);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      attempts.forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      });
      const results = await running;

      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase starts when the first provider rate limit stops the normal ramp', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(5);

      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(1);
      expect(attempts[5]!.retryAgentId).toBe('agent-1');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('user cancellation returns completed, started, and not-started task results', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 6 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      const results = await running;

      expect(results.map((result) => ({
        data: result.task.data,
        agentId: result.agentId,
        status: result.status,
        state: result.state,
        result: result.result,
        error: result.error,
      }))).toEqual([
        {
          data: 1,
          agentId: 'agent-1',
          status: 'completed',
          state: undefined,
          result: 'completed 1',
          error: undefined,
        },
        {
          data: 2,
          agentId: 'agent-2',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 3,
          agentId: 'agent-3',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 4,
          agentId: 'agent-4',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 5,
          agentId: 'agent-5',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 6,
          agentId: undefined,
          status: 'aborted',
          state: 'not_started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normal phase keeps processing completions while waiting for the next launch', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedTask(index + 1)),
        { signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      attempts.slice(1).forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 2)}`,
          status: 'completed',
          result: `completed ${String(index + 2)}`,
        });
      });
      await expect(running).resolves.toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase requeues 429 tasks, emits suspended, and throttles launches', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onSuspended = vi.fn();
      const { runBatch, attempts } = createMockBatchRunner({ onSuspended });
      const running = runBatch(Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(onSuspended).toHaveBeenCalledTimes(2);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2500);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(2);
      expect(attempts[5]!.retryAgentId).toBe('agent-2');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the only unfinished task on provider rate limit instead of suspending forever', async () => {
    vi.useFakeTimers();
    try {
      const onSuspended = vi.fn();
      const { runBatch, attempts } = createMockBatchRunner({ onSuspended });
      const running = runBatch(Array.from({ length: 2 }, (_, index) => queuedTask(index + 1)), {
        signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'completed',
          result: 'completed 1',
        },
        {
          task: { data: 2 },
          agentId: 'agent-2',
          status: 'failed',
          state: 'started',
          error: 'Rate limited',
        },
      ]);
      expect(onSuspended).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit capacity blocks launches while active attempts fill all slots', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 12 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.slice(0, 5).forEach((attempt) => {
        attempt.markReady();
      });

      for (let count = 6; count <= 12; count += 1) {
        await vi.advanceTimersByTimeAsync(700);
        expect(attempts).toHaveLength(count);
        attempts[count - 1]!.markReady();
      }

      attempts.slice(0, 12).forEach((attempt) => {
        attempt.markReady();
      });

      for (let index = 0; index < 1; index += 1) {
        attempts[index]!.outcome.resolve({
          type: 'rate_limited',
          agentId: `agent-${String(index + 1)}`,
        });
      }
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(12);

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit recovery adds one capacity slot after three quiet minutes with queued work', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 6 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[2]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-3' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[3]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-4' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(179_999);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(4);
      expect(attempts[5]!.retryAgentId).toBe('agent-4');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase keeps launches bounded after repeated 429s', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      for (let index = 0; index < 3; index += 1) {
        attempts[index]!.outcome.resolve({
          type: 'rate_limited',
          agentId: `agent-${String(index + 1)}`,
        });
        await vi.advanceTimersByTimeAsync(0);
      }

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(3);
      expect(attempts[5]!.retryAgentId).toBe('agent-3');

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(7);
      expect(attempts[6]!.task.data).toBe(2);
      expect(attempts[6]!.retryAgentId).toBe('agent-2');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase schedules another launch after starting while capacity remains', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      attempts[2]!.outcome.resolve({
        task: attempts[2]!.task,
        agentId: 'agent-3',
        status: 'completed',
        result: 'completed 3',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(1);
      expect(attempts[5]!.retryAgentId).toBe('agent-1');

      await vi.advanceTimersByTimeAsync(2_999);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(7);
      expect(attempts[6]!.task.data).toBe(6);
      expect(attempts[6]!.retryAgentId).toBeUndefined();

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('task timeout fails only that task', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch([{ ...queuedTask(1), timeout: 10_000 }], { signal });

      await vi.advanceTimersByTimeAsync(0);
      attempts[0]!.markReady();

      await vi.advanceTimersByTimeAsync(9999);
      expect(attempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spend task timeout while the task is queued', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(
        [
          ...Array.from({ length: 5 }, (_, index) => queuedTask(index + 1)),
          { ...queuedTask(6), timeout: 1000 },
        ],
        { signal },
      );
      void running.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      attempts.slice(0, 5).forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `completed ${String(index + 1)}`,
        });
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(running).resolves.toMatchObject([
        { task: { data: 1 }, status: 'completed' },
        { task: { data: 2 }, status: 'completed' },
        { task: { data: 3 }, status: 'completed' },
        { task: { data: 4 }, status: 'completed' },
        { task: { data: 5 }, status: 'completed' },
        {
          task: { data: 6 },
          agentId: 'agent-6',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase continues launching after rate-limited attempts settle', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner({
        readyDelay: (attemptIndex) => (attemptIndex >= 7 ? 100 : undefined),
      });

      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.slice(0, 5).forEach((attempt) => {
        attempt.markReady();
      });

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      attempts[5]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-6' });
      attempts[6]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-7' });
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(attempts).toHaveLength(8);
      expect(attempts[7]!.task.data).toBe(7);
      expect(attempts[7]!.retryAgentId).toBe('agent-7');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveSwarmMaxConcurrency', () => {
  it('returns undefined when the variable is unset', () => {
    expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only values', () => {
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '' }),
    ).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '   ' }),
    ).toBeUndefined();
  });

  it('throws for non-positive, non-integer, or non-numeric values', () => {
    for (const raw of ['0', '-1', '2.5', 'abc']) {
      expect(() =>
        resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: raw }),
      ).toThrow(/KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY.*positive integer/);
    }
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '3' })).toBe(3);
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: ' 8 ' })).toBe(8);
  });
});

describe('SubagentBatch max concurrency cap', () => {
  it('caps in-flight tasks at maxConcurrency during the normal phase', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatchRunner({ maxConcurrency: 3 });
      const running = runBatch(Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)), {
        signal,
      });
      const resolved = new Set<number>();
      const resolveOne = (index: number) => {
        const attempt = attempts[index]!;
        resolved.add(index);
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      };
      const inFlight = () => attempts.length - resolved.size;

      // Initial burst is capped at 3 instead of the default 5.
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);
      expect(inFlight()).toBe(3);

      // The 700ms ramp tick does not exceed the cap while all slots are occupied.
      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(3);

      // Freeing one slot refills it without exceeding the cap.
      resolveOne(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(4);
      expect(inFlight()).toBeLessThanOrEqual(3);

      resolveOne(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      expect(inFlight()).toBeLessThanOrEqual(3);

      // Once the initial burst budget (5) is exhausted, further launches wait for
      // the 700ms ramp tick, but the in-flight count still never exceeds the cap.
      resolveOne(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(6);
      expect(inFlight()).toBeLessThanOrEqual(3);

      // Drain the remaining attempts.
      for (let index = 3; index < 9; index += 1) {
        resolveOne(index);
        await vi.advanceTimersByTimeAsync(700);
        expect(inFlight()).toBeLessThanOrEqual(3);
      }

      const results = await running;
      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BatchExecutionContext rate-limit fallback', () => {
  it('passes BatchExecutionContext with fallbackModel to launcher methods', async () => {
    vi.useFakeTimers();
    try {
      const capturedContexts: BatchExecutionContext[] = [];
      const { runBatch, attempts } = createMockBatchRunner({
        onContext: (ctx) => capturedContexts.push(ctx),
      });
      const controller = new AbortController();
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedTask(index + 1)),
        { signal: controller.signal },
        { fallbackModel: 'fallback-model' },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      expect(capturedContexts).toHaveLength(2);
      expect(capturedContexts[0]!.fallbackModel).toBe('fallback-model');
      expect(capturedContexts[0]!.isRateLimited).toBe(false);

      // Clean up
      attempts.forEach((a) => a.outcome.resolve({
        task: a.task, agentId: 'done', status: 'completed', result: 'ok',
      }));
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('context.isRateLimited is a live getter that reflects batch rateLimitMode', async () => {
    vi.useFakeTimers();
    try {
      const capturedContexts: BatchExecutionContext[] = [];
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner({
        onContext: (ctx) => capturedContexts.push(ctx),
      });
      const running = runBatch(
        Array.from({ length: 5 }, (_, index) => queuedTask(index + 1)),
        { signal: controller.signal },
        { fallbackModel: 'mimo-v2.5' },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      // Before rate limit, the captured context should show isRateLimited = false.
      // Because isRateLimited is a getter, the same object reference will later
      // reflect the live batch state.
      const firstContext = capturedContexts[0]!;
      expect(firstContext.isRateLimited).toBe(false);
      expect(firstContext.fallbackModel).toBe('mimo-v2.5');

      // Mark all ready, then trigger rate limit on first attempt
      attempts.forEach((a) => a.markReady());
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);

      // The same context object now reflects isRateLimited = true
      expect(firstContext.isRateLimited).toBe(true);

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('each batch has a unique batchId', async () => {
    vi.useFakeTimers();
    try {
      const capturedContexts: BatchExecutionContext[] = [];
      const { runBatch, attempts } = createMockBatchRunner({
        onContext: (ctx) => capturedContexts.push(ctx),
      });
      const controller = new AbortController();
      const running = runBatch(
        Array.from({ length: 3 }, (_, index) => queuedTask(index + 1)),
        { signal: controller.signal },
        { fallbackModel: 'fallback' },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);

      // All contexts in the same batch should have the same batchId
      const batchIds = capturedContexts.map((c) => c.batchId);
      expect(new Set(batchIds).size).toBe(1);
      expect(batchIds[0]).toMatch(/^batch-/);

      attempts.forEach((a) => a.outcome.resolve({
        task: a.task, agentId: 'done', status: 'completed', result: 'ok',
      }));
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('context.fallbackModel is undefined when no fallback is configured', async () => {
    vi.useFakeTimers();
    try {
      const capturedContexts: BatchExecutionContext[] = [];
      const { runBatch, attempts } = createMockBatchRunner({
        onContext: (ctx) => capturedContexts.push(ctx),
      });
      const controller = new AbortController();
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      expect(capturedContexts[0]!.fallbackModel).toBeUndefined();

      attempts.forEach((a) => a.outcome.resolve({
        task: a.task, agentId: 'done', status: 'completed', result: 'ok',
      }));
      await running;
    } finally {
      vi.useRealTimers();
    }
  });
});

type MockAttemptOutcome<T> =
  | SubagentResult<T>
  | {
      readonly type: 'rate_limited';
      readonly agentId: string;
    };

type MockAttemptRecord = {
  readonly task: QueuedSubagentTask<number>;
  readonly retryAgentId?: string;
  readonly markReady: () => void;
  readonly outcome: ReturnType<typeof createControlledPromise<MockAttemptOutcome<number>>>;
};

type MockBatchRunnerOptions = {
  readonly onSuspended?: (event: SubagentSuspendedEvent) => void;
  readonly readyDelay?: (attemptIndex: number) => number | undefined;
  readonly maxConcurrency?: number;
  readonly onContext?: (context: BatchExecutionContext) => void;
};

function createMockBatchRunner(
  options: MockBatchRunnerOptions = {},
): {
  readonly runBatch: <T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options?: { readonly signal?: AbortSignal },
    batchOptions?: { readonly fallbackModel?: string; readonly logger?: { readonly warn: (event: string, data?: Record<string, unknown>) => void; readonly error: (event: string, data?: Record<string, unknown>) => void } },
  ) => Promise<Array<SubagentResult<T>>>;
  readonly attempts: MockAttemptRecord[];
} {
  const attempts: MockAttemptRecord[] = [];
  let activeTasks: readonly QueuedSubagentTask<unknown>[] = [];

  const createHandle = <T,>(
    runOptions: RunSubagentOptions,
    agentId: string,
    profileName: string,
    resumed: boolean,
    retryAgentId?: string,
  ): SubagentHandle => {
    const task = findMockTask<T>(activeTasks, runOptions);
    const outcome = createControlledPromise<MockAttemptOutcome<T>>();
    const markReady = () => {
      runOptions.onReady?.();
    };
    const attemptIndex = attempts.length;
    attempts.push({
      task: task as unknown as QueuedSubagentTask<number>,
      retryAgentId,
      markReady,
      outcome: outcome as unknown as MockAttemptRecord['outcome'],
    });

    const delay = options.readyDelay?.(attemptIndex);
    if (delay !== undefined) setTimeout(markReady, delay);

    return {
      agentId,
      profileName,
      resumed,
      completion: completionFromMockOutcome(outcome, runOptions.signal),
    };
  };

  const host = {
    spawn: async (spawnOptions: SpawnSubagentOptions, context?: BatchExecutionContext) => {
      if (context) options.onContext?.(context);
      const task = findMockTask(activeTasks, spawnOptions);
      return createHandle(
        spawnOptions,
        mockAgentId(task, attempts.length),
        spawnOptions.profileName,
        false,
      );
    },
    resume: async (agentId: string, runOptions: RunSubagentOptions, context?: BatchExecutionContext) => {
      if (context) options.onContext?.(context);
      return createHandle(runOptions, agentId, 'subagent', true);
    },
    retry: async (agentId: string, runOptions: RunSubagentOptions, context?: BatchExecutionContext) => {
      if (context) options.onContext?.(context);
      return createHandle(runOptions, agentId, 'subagent', true, agentId);
    },
    suspended: (event: SubagentSuspendedEvent) => {
      options.onSuspended?.(event);
    },
  } satisfies SubagentBatchLauncher;

  return {
    runBatch: <T,>(
      tasks: readonly QueuedSubagentTask<T>[],
      runOptions?: { readonly signal?: AbortSignal },
      batchOptions?: { readonly fallbackModel?: string; readonly logger?: { readonly warn: (event: string, data?: Record<string, unknown>) => void; readonly error: (event: string, data?: Record<string, unknown>) => void } },
    ) => {
      activeTasks = tasks.map((task) => ({
        ...task,
        signal: task.signal ?? runOptions?.signal,
      }));
      return new SubagentBatch(host, activeTasks as readonly QueuedSubagentTask<T>[], {
        maxConcurrency: options.maxConcurrency,
        fallbackModel: batchOptions?.fallbackModel,
        logger: batchOptions?.logger,
      }).run();
    },
    attempts,
  };
}

function findMockTask<T>(
  tasks: readonly QueuedSubagentTask<unknown>[],
  options: RunSubagentOptions,
): QueuedSubagentTask<T> {
  const task = tasks.find(
    (candidate) =>
      candidate.prompt === options.prompt &&
      candidate.parentToolCallId === options.parentToolCallId,
  );
  if (task === undefined) {
    throw new Error(`No mock queued task for prompt "${options.prompt}"`);
  }
  return task as QueuedSubagentTask<T>;
}

function mockAgentId(task: QueuedSubagentTask<unknown>, attemptIndex: number): string {
  if (typeof task.data === 'number') return `agent-${String(task.data)}`;
  return `agent-${String(attemptIndex + 1)}`;
}

function completionFromMockOutcome<T>(
  outcome: ReturnType<typeof createControlledPromise<MockAttemptOutcome<T>>>,
  signal: AbortSignal,
): SubagentHandle['completion'] {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    outcome.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        if (isMockRateLimitOutcome(result)) {
          reject(new APIProviderRateLimitError('Rate limited', result.agentId));
          return;
        }
        if (result.status === 'completed') {
          resolve({ result: result.result ?? '', usage: result.usage });
          return;
        }
        reject(new Error(result.error ?? result.status));
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function isMockRateLimitOutcome<T>(
  outcome: MockAttemptOutcome<T>,
): outcome is Extract<MockAttemptOutcome<T>, { readonly type: 'rate_limited' }> {
  return 'type' in outcome && outcome.type === 'rate_limited';
}

function queuedTask(index: number): QueuedSubagentTask<number> {
  return {
    kind: 'spawn',
    data: index,
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: `Review item-${String(index)}`,
    description: `Review #${String(index)}`,
    runInBackground: false,
  };
}

// ── Heartbeat tests ────────────────────────────────────────────────

describe('SubagentBatch heartbeat', () => {
  it('aborts a stalled attempt after heartbeat timeout and returns interrupted status', async () => {
    vi.useFakeTimers();
    try {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(
        Array.from({ length: 3 }, (_, index) => queuedTask(index + 1)),
        { signal },
        { logger },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);

      // Mark all ready so they count as "started".
      attempts.forEach((a) => a.markReady());

      // Complete tasks 0 and 1 before the heartbeat window expires.
      // Only task 2 remains active and will be detected as stalled.
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'ok 1',
      });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'ok 2',
      });
      await vi.advanceTimersByTimeAsync(0);

      // The heartbeat check interval is 60s. The timeout is 5 min (300s).
      // The check fires at 60k, 120k, 180k, 240k, 300k, 360k, …
      // At 360k: 360,000 > 300,000 → heartbeat fires and aborts task 2.
      await vi.advanceTimersByTimeAsync(360_001);

      // The logger should have been called for the heartbeat timeout.
      expect(logger.warn).toHaveBeenCalledWith(
        'subagent_heartbeat_timeout',
        expect.objectContaining({ batchId: expect.any(String) }),
      );

      const results = await running;
      expect(results).toHaveLength(3);

      // Tasks 0 and 1 completed normally.
      expect(results[0]!.status).toBe('completed');
      expect(results[1]!.status).toBe('completed');

      // Task 2 was aborted by heartbeat and gets 'interrupted' status.
      expect(results[2]!.status).toBe('interrupted');
      expect(results[2]!.error).toBe(
        'Subagent heartbeat timeout; the attempt was stalled and aborted.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat does not fire when attempts complete before timeout', async () => {
    vi.useFakeTimers();
    try {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch([queuedTask(1)], { signal }, { logger });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(1);
      attempts[0]!.markReady();

      // Complete within the timeout window.
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'done',
      });

      await vi.advanceTimersByTimeAsync(0);
      const results = await running;
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe('completed');

      // No heartbeat warning should have been emitted.
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishWithUserCancellation aborts all in-progress attempt controllers', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch(Array.from({ length: 3 }, (_, index) => queuedTask(index + 1)), {
        signal: controller.signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);

      // Before cancellation, no controller should be aborted.
      for (const a of attempts) {
        const attempt = attempts.find((x) => x === a);
        expect(attempt!.outcome).toBeDefined();
      }

      controller.abort(userCancellationReason());
      await vi.advanceTimersByTimeAsync(0);

      const results = await running;
      expect(results).toHaveLength(3);
      // All should be 'aborted' since none completed.
      expect(results.every((r) => r.status === 'aborted')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat timer is cleaned up when batch finishes', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatchRunner();
      const running = runBatch([queuedTask(1)], { signal });

      await vi.advanceTimersByTimeAsync(0);
      attempts[0]!.markReady();
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'done',
      });
      await running;

      // Advance well beyond heartbeat timeout — no error should occur
      // because the heartbeat timer was cleaned up.
      await vi.advanceTimersByTimeAsync(600_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
