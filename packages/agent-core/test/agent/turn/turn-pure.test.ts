import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
} from '@moonshot-ai/kosong';
import { ErrorCodes, KimiError, type KimiErrorCode, type KimiErrorPayload } from '../../../src/errors';
import type { TokenUsage } from '@moonshot-ai/kosong';
import type { LoopEvent, LoopTurnInterruptedEvent, ExecutableToolResult } from '../../../src/loop/index';

import {
  isGoalOutcomeReminderOrigin,
  hasStepBudgetRemaining,
  mapLoopEvent,
  summarizeTurnError,
  goalFailurePauseReason,
  pauseReasonWithMessage,
  toolInputRecord,
  toolOutputText,
  interruptedStep,
  classifyApiError,
  apiStatusCode,
  summaryStatusCode,
  isApiConnectionError,
  isApiTimeoutError,
  isApiEmptyResponseError,
  currentTurnInputTokens,
  telemetryToolOutcome,
  telemetryToolErrorType,
  toolResultText,
} from '../../../src/agent/turn/turn-pure';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides?: Partial<KimiErrorPayload>): KimiErrorPayload {
  return {
    name: 'Error',
    message: 'something went wrong',
    code: ErrorCodes.PROVIDER_API_ERROR,
    retryable: false,
    ...overrides,
  };
}

// ===========================================================================
// isGoalOutcomeReminderOrigin
// ===========================================================================

describe.concurrent('isGoalOutcomeReminderOrigin', () => {
  it('returns true for goal_completion origin', () => {
    expect(isGoalOutcomeReminderOrigin({ kind: 'system_trigger', name: 'goal_completion' })).toBe(true);
  });

  it('returns true for goal_blocked origin', () => {
    expect(isGoalOutcomeReminderOrigin({ kind: 'system_trigger', name: 'goal_blocked' })).toBe(true);
  });

  it('returns false for goal_continuation origin', () => {
    expect(isGoalOutcomeReminderOrigin({ kind: 'system_trigger', name: 'goal_continuation' })).toBe(false);
  });

  it('returns false for user origin', () => {
    expect(isGoalOutcomeReminderOrigin({ kind: 'user' } as any)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isGoalOutcomeReminderOrigin(undefined)).toBe(false);
  });

  it('PBT: never throws on arbitrary origin-like data', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            kind: fc.constantFrom('system_trigger', 'user', 'other'),
            name: fc.string({ minLength: 1 }),
          }),
        ),
        (origin) => {
          expect(() => isGoalOutcomeReminderOrigin(origin as any)).not.toThrow();
          expect(typeof isGoalOutcomeReminderOrigin(origin as any)).toBe('boolean');
        },
      ),
    );
  });
});

// ===========================================================================
// hasStepBudgetRemaining
// ===========================================================================

describe.concurrent('hasStepBudgetRemaining', () => {
  it('returns true when maxSteps is undefined', () => {
    expect(hasStepBudgetRemaining(undefined, 100)).toBe(true);
  });

  it('returns true when maxSteps is zero', () => {
    expect(hasStepBudgetRemaining(0, 5)).toBe(true);
  });

  it('returns true when maxSteps is negative', () => {
    expect(hasStepBudgetRemaining(-1, 5)).toBe(true);
  });

  it('returns true when currentStep < maxSteps', () => {
    expect(hasStepBudgetRemaining(10, 5)).toBe(true);
  });

  it('returns false when currentStep === maxSteps', () => {
    expect(hasStepBudgetRemaining(10, 10)).toBe(false);
  });

  it('returns false when currentStep > maxSteps', () => {
    expect(hasStepBudgetRemaining(10, 15)).toBe(false);
  });

  it('PBT: never throws on arbitrary numbers', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
        fc.integer({ min: 0, max: 1000 }),
        (maxSteps, currentStep) => {
          expect(() => hasStepBudgetRemaining(maxSteps, currentStep)).not.toThrow();
          expect(typeof hasStepBudgetRemaining(maxSteps, currentStep)).toBe('boolean');
        },
      ),
    );
  });
});

// ===========================================================================
// mapLoopEvent
// ===========================================================================

describe.concurrent('mapLoopEvent', () => {
  it('maps step.begin to turn.step.started', () => {
    const event: LoopEvent = { type: 'step.begin', step: 1, uuid: 'u1' } as unknown as LoopEvent;
    const result = mapLoopEvent(event, 42);
    expect(result).toEqual({ type: 'turn.step.started', turnId: 42, step: 1, stepId: 'u1' });
  });

  it('maps step.end to turn.step.completed', () => {
    const event: LoopEvent = {
      type: 'step.end', step: 2, uuid: 'u2', usage: undefined,
      finishReason: 'stop', llmFirstTokenLatencyMs: 10, llmStreamDurationMs: 100,
      providerFinishReason: 'stop', rawFinishReason: 'stop',
    } as unknown as LoopEvent;
    const result = mapLoopEvent(event, 7);
    expect(result).toBeDefined();
    expect(result!.type).toBe('turn.step.completed');
    expect((result as any).turnId).toBe(7);
  });

  it('maps content.part to undefined', () => {
    const event: LoopEvent = { type: 'content.part', delta: 'hi' } as unknown as LoopEvent;
    expect(mapLoopEvent(event, 1)).toBeUndefined();
  });

  it('maps turn.interrupted with no activeStep to undefined', () => {
    const event: LoopEvent = { type: 'turn.interrupted', reason: 'user', attemptedSteps: 3 } as unknown as LoopEvent;
    expect(mapLoopEvent(event, 1)).toBeUndefined();
  });

  it('maps turn.interrupted with activeStep to turn.step.interrupted', () => {
    const event: LoopEvent = {
      type: 'turn.interrupted', activeStep: 5, reason: 'user', message: 'cancelled', attemptedSteps: 3,
    } as unknown as LoopEvent;
    const result = mapLoopEvent(event, 1);
    expect(result).toBeDefined();
    expect(result!.type).toBe('turn.step.interrupted');
  });

  it('maps text.delta to assistant.delta', () => {
    const event: LoopEvent = { type: 'text.delta', delta: 'hello' } as unknown as LoopEvent;
    const result = mapLoopEvent(event, 1);
    expect(result).toEqual({ type: 'assistant.delta', turnId: 1, delta: 'hello' });
  });

  it('returns undefined for an unrecognized event type via default branch', () => {
    const event = { type: 'unknown_future_event' } as unknown as LoopEvent;
    expect(mapLoopEvent(event, 1)).toBeUndefined();
  });

  it('PBT: never throws on any event type string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 1000 }),
        (eventType, turnId) => {
          const event = { type: eventType } as unknown as LoopEvent;
          expect(() => mapLoopEvent(event, turnId)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// summarizeTurnError
// ===========================================================================

describe.concurrent('summarizeTurnError', () => {
  it('returns a KimiErrorPayload with turnId in details', () => {
    const result = summarizeTurnError(new Error('boom'), 5);
    expect(result.details).toBeDefined();
    expect(result.details!['turnId']).toBe(5);
    expect(result._effect).toBe('NONE');
  });

  it('substitutes friendly message for model.not_configured code', () => {
    const error = new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    const result = summarizeTurnError(error, 1);
    expect(result.message).toBe('LLM not set, send "/login" to login');
  });

  it('preserves original message for non-model-not-configured errors', () => {
    const result = summarizeTurnError(new Error('rate limited'), 1);
    expect(result.message).not.toBe('LLM not set, send "/login" to login');
  });

  it('PBT: never throws on arbitrary error inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined)),
        fc.nat({ max: 100 }),
        (error, turnId) => {
          expect(() => summarizeTurnError(error, turnId)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// goalFailurePauseReason
// ===========================================================================

describe.concurrent('goalFailurePauseReason', () => {
  it('returns rate limit reason for PROVIDER_RATE_LIMIT', () => {
    const error = makeSummary({ code: ErrorCodes.PROVIDER_RATE_LIMIT });
    expect(goalFailurePauseReason(error)).toBe('Paused after provider rate limit');
  });

  it('returns connection error reason with message', () => {
    const error = makeSummary({ code: ErrorCodes.PROVIDER_CONNECTION_ERROR, message: 'refused' });
    expect(goalFailurePauseReason(error)).toBe('Paused after provider connection error: refused');
  });

  it('returns auth error reason with message', () => {
    const error = makeSummary({ code: ErrorCodes.PROVIDER_AUTH_ERROR, message: 'invalid key' });
    expect(goalFailurePauseReason(error)).toBe('Paused after provider authentication error: invalid key');
  });

  it('returns API error reason with message', () => {
    const error = makeSummary({ code: ErrorCodes.PROVIDER_API_ERROR, message: '502' });
    expect(goalFailurePauseReason(error)).toBe('Paused after provider API error: 502');
  });

  it('returns model config reason for MODEL_NOT_CONFIGURED', () => {
    const error = makeSummary({ code: ErrorCodes.MODEL_NOT_CONFIGURED, message: 'not set' });
    expect(goalFailurePauseReason(error)).toBe('Paused after model configuration error: not set');
  });

  it('returns model config reason for MODEL_CONFIG_INVALID', () => {
    const error = makeSummary({ code: ErrorCodes.MODEL_CONFIG_INVALID, message: '' });
    expect(goalFailurePauseReason(error)).toBe('Paused after model configuration error');
  });

  it('returns runtime error reason as fallback', () => {
    const error = makeSummary({ code: 'something.else' as KimiErrorCode, message: 'oops' });
    expect(goalFailurePauseReason(error)).toBe('Paused after runtime error: oops');
  });

  it('returns runtime error reason for undefined error', () => {
    expect(goalFailurePauseReason(undefined)).toBe('Paused after runtime error');
  });

  it('PBT: never throws on arbitrary error codes', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            code: fc.string({ minLength: 1 }),
            name: fc.string(),
            message: fc.option(fc.string(), { nil: undefined }),
          } as any),
          { nil: undefined },
        ),
        (error) => {
          expect(() => goalFailurePauseReason(error as any)).not.toThrow();
          expect(typeof goalFailurePauseReason(error as any)).toBe('string');
        },
      ),
    );
  });
});

// ===========================================================================
// pauseReasonWithMessage
// ===========================================================================

describe.concurrent('pauseReasonWithMessage', () => {
  it('returns prefix when message is undefined', () => {
    expect(pauseReasonWithMessage('prefix', undefined)).toBe('prefix');
  });

  it('returns prefix when message is empty', () => {
    expect(pauseReasonWithMessage('prefix', '')).toBe('prefix');
  });

  it('appends message with colon separator', () => {
    expect(pauseReasonWithMessage('prefix', 'detail')).toBe('prefix: detail');
  });

  it('PBT: never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        (prefix, message) => {
          expect(() => pauseReasonWithMessage(prefix, message)).not.toThrow();
          expect(typeof pauseReasonWithMessage(prefix, message)).toBe('string');
        },
      ),
    );
  });
});

// ===========================================================================
// toolInputRecord
// ===========================================================================

describe.concurrent('toolInputRecord', () => {
  it('returns the object when given a plain record', () => {
    const args = { a: 1, b: 'two' };
    expect(toolInputRecord(args)).toEqual(args);
  });

  it('returns empty object for a string', () => {
    expect(toolInputRecord('not an object')).toEqual({});
  });

  it('returns empty object for a number', () => {
    expect(toolInputRecord(42)).toEqual({});
  });

  it('returns empty object for null', () => {
    expect(toolInputRecord(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(toolInputRecord(undefined)).toEqual({});
  });

  it('returns empty object for an array', () => {
    expect(toolInputRecord([1, 2, 3])).toEqual({});
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (args) => {
          expect(() => toolInputRecord(args)).not.toThrow();
          expect(typeof toolInputRecord(args)).toBe('object');
        },
      ),
    );
  });
});

// ===========================================================================
// toolOutputText
// ===========================================================================

describe.concurrent('toolOutputText', () => {
  it('returns string directly when output is a string', () => {
    expect(toolOutputText('hello')).toBe('hello');
  });

  it('joins text parts from an array', () => {
    const parts = [
      { type: 'text' as const, text: 'hello ' },
      { type: 'text' as const, text: 'world' },
    ];
    expect(toolOutputText(parts)).toBe('hello world');
  });

  it('filters out non-text parts', () => {
    const parts = [
      { type: 'text' as const, text: 'hello' },
      { type: 'image' as const, url: 'data:image/png;base64,abc' },
    ] as unknown as ExecutableToolResult['output'];
    expect(toolOutputText(parts)).toBe('hello');
  });

  it('returns empty string for empty array', () => {
    expect(toolOutputText([] as unknown as ExecutableToolResult['output'])).toBe('');
  });

  it('returns empty string when all parts are non-text', () => {
    const parts = [
      { type: 'image' as const, url: 'abc' },
    ] as unknown as ExecutableToolResult['output'];
    expect(toolOutputText(parts)).toBe('');
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constant([] as unknown as ExecutableToolResult['output']),
        ),
        (output) => {
          expect(() => toolOutputText(output)).not.toThrow();
          expect(typeof toolOutputText(output)).toBe('string');
        },
      ),
    );
  });
});

// ===========================================================================
// interruptedStep
// ===========================================================================

describe.concurrent('interruptedStep', () => {
  it('returns activeStep when defined', () => {
    expect(interruptedStep({ activeStep: 5, attemptedSteps: 3 } as unknown as LoopTurnInterruptedEvent)).toBe(5);
  });

  it('returns attemptedSteps when activeStep is undefined', () => {
    expect(interruptedStep({ activeStep: undefined, attemptedSteps: 8 } as unknown as LoopTurnInterruptedEvent)).toBe(8);
  });

  it('returns attemptedSteps when activeStep is null', () => {
    expect(interruptedStep({ activeStep: null, attemptedSteps: 4 } as unknown as LoopTurnInterruptedEvent)).toBe(4);
  });

  it('PBT: never throws on arbitrary step numbers', () => {
    fc.assert(
      fc.property(
        fc.option(fc.nat({ max: 1000 }), { nil: undefined }),
        fc.nat({ max: 1000 }),
        (activeStep, attemptedSteps) => {
          expect(() => interruptedStep({ activeStep, attemptedSteps } as unknown as LoopTurnInterruptedEvent)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// classifyApiError
// ===========================================================================

describe.concurrent('classifyApiError', () => {
  it('classifies 429 as rate_limit', () => {
    const error = new APIStatusError(429, 'rate limited');
    const summary = makeSummary();
    const result = classifyApiError(error, summary);
    expect(result.errorType).toBe('rate_limit');
    expect(result.statusCode).toBe(429);
    expect(result._effect).toBe('NONE');
  });

  it('classifies 401 as auth', () => {
    const error = new APIStatusError(401, 'unauth');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('auth');
  });

  it('classifies 403 as auth', () => {
    const error = new APIStatusError(403, 'forbidden');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('auth');
  });

  it('classifies 500+ as 5xx_server', () => {
    const error = new APIStatusError(500, 'server error');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('5xx_server');
  });

  it('classifies 503 as 5xx_server', () => {
    const error = new APIStatusError(503, 'unavailable');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('5xx_server');
  });

  it('classifies 400 as 4xx_client', () => {
    const error = new APIStatusError(400, 'bad request');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('4xx_client');
  });

  it('falls back to summary code for rate limit', () => {
    const summary = makeSummary({ code: ErrorCodes.PROVIDER_RATE_LIMIT });
    expect(classifyApiError({}, summary).errorType).toBe('rate_limit');
  });

  it('falls back to summary code for auth error', () => {
    const summary = makeSummary({ code: ErrorCodes.PROVIDER_AUTH_ERROR });
    expect(classifyApiError({}, summary).errorType).toBe('auth');
  });

  it('falls back to summary code for context overflow', () => {
    const summary = makeSummary({ code: ErrorCodes.CONTEXT_OVERFLOW });
    expect(classifyApiError({}, summary).errorType).toBe('context_overflow');
  });

  it('classifies connection error as network', () => {
    const error = new APIConnectionError('refused');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('network');
  });

  it('classifies timeout error as timeout', () => {
    const error = new APITimeoutError('timed out');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('timeout');
  });

  it('classifies empty response as empty_response', () => {
    const error = new APIEmptyResponseError('empty');
    expect(classifyApiError(error, makeSummary()).errorType).toBe('empty_response');
  });

  it('returns other for completely unknown error', () => {
    const summary = makeSummary({ code: 'something.else' as KimiErrorCode });
    expect(classifyApiError({}, summary).errorType).toBe('other');
  });

  it('NEVER throws — returns UNKNOWN type for unexpected input (Principle A)', () => {
    expect(() => classifyApiError(null, makeSummary())).not.toThrow();
    expect(classifyApiError(null, makeSummary()).errorType).toBe('other');
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.record({ statusCode: fc.integer() }),
        ),
        fc.record({
          name: fc.string(),
          message: fc.string(),
          code: fc.string(),
        } as any),
        (error, summary) => {
          expect(() => classifyApiError(error, summary as KimiErrorPayload)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// apiStatusCode
// ===========================================================================

describe.concurrent('apiStatusCode', () => {
  it('extracts statusCode from APIStatusError', () => {
    const error = new APIStatusError(503, 'err');
    expect(apiStatusCode(error)).toBe(503);
  });

  it('extracts statusCode from plain object', () => {
    expect(apiStatusCode({ statusCode: 404 })).toBe(404);
  });

  it('extracts status from plain object', () => {
    expect(apiStatusCode({ status: 410 })).toBe(410);
  });

  it('returns undefined for null', () => {
    expect(apiStatusCode(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(apiStatusCode(undefined)).toBeUndefined();
  });

  it('returns undefined for string', () => {
    expect(apiStatusCode('error')).toBeUndefined();
  });

  it('returns undefined for object with non-number statusCode', () => {
    expect(apiStatusCode({ statusCode: '500' })).toBeUndefined();
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (error) => {
          expect(() => apiStatusCode(error)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// summaryStatusCode
// ===========================================================================

describe.concurrent('summaryStatusCode', () => {
  it('extracts statusCode from details', () => {
    expect(summaryStatusCode(makeSummary({ details: { statusCode: 429 } }))).toBe(429);
  });

  it('returns undefined when details has no statusCode', () => {
    expect(summaryStatusCode(makeSummary({ details: {} }))).toBeUndefined();
  });

  it('returns undefined when statusCode is not a number', () => {
    expect(summaryStatusCode(makeSummary({ details: { statusCode: '500' } }))).toBeUndefined();
  });

  it('returns undefined when details is undefined', () => {
    expect(summaryStatusCode(makeSummary({ details: undefined }))).toBeUndefined();
  });

  it('PBT: never throws on arbitrary summary objects', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string(),
          message: fc.string(),
          code: fc.string(),
        } as any),
        (summary) => {
          expect(() => summaryStatusCode(summary as KimiErrorPayload)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// isApiConnectionError
// ===========================================================================

describe.concurrent('isApiConnectionError', () => {
  it('returns true for APIConnectionError instance', () => {
    expect(isApiConnectionError(new APIConnectionError('refused'), makeSummary())).toBe(true);
  });

  it('returns true when summary name matches', () => {
    expect(isApiConnectionError({}, makeSummary({ name: 'APIConnectionError' }))).toBe(true);
  });

  it('returns false for unrelated error', () => {
    expect(isApiConnectionError(new Error('boom'), makeSummary())).toBe(false);
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        fc.record({ name: fc.string(), message: fc.string(), code: fc.string() } as any),
        (error, summary) => {
          expect(() => isApiConnectionError(error, summary as KimiErrorPayload)).not.toThrow();
          expect(typeof isApiConnectionError(error, summary as KimiErrorPayload)).toBe('boolean');
        },
      ),
    );
  });
});

// ===========================================================================
// isApiTimeoutError
// ===========================================================================

describe.concurrent('isApiTimeoutError', () => {
  it('returns true for APITimeoutError instance', () => {
    expect(isApiTimeoutError(new APITimeoutError('timed out'), makeSummary())).toBe(true);
  });

  it('returns true when summary name is APITimeoutError', () => {
    expect(isApiTimeoutError({}, makeSummary({ name: 'APITimeoutError' }))).toBe(true);
  });

  it('returns true when summary name is TimeoutError', () => {
    expect(isApiTimeoutError({}, makeSummary({ name: 'TimeoutError' }))).toBe(true);
  });

  it('returns false for unrelated error', () => {
    expect(isApiTimeoutError(new Error('boom'), makeSummary())).toBe(false);
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        fc.record({ name: fc.string(), message: fc.string(), code: fc.string() } as any),
        (error, summary) => {
          expect(() => isApiTimeoutError(error, summary as KimiErrorPayload)).not.toThrow();
          expect(typeof isApiTimeoutError(error, summary as KimiErrorPayload)).toBe('boolean');
        },
      ),
    );
  });
});

// ===========================================================================
// isApiEmptyResponseError
// ===========================================================================

describe.concurrent('isApiEmptyResponseError', () => {
  it('returns true for APIEmptyResponseError instance', () => {
    expect(isApiEmptyResponseError(new APIEmptyResponseError('empty'), makeSummary())).toBe(true);
  });

  it('returns true when summary name matches', () => {
    expect(isApiEmptyResponseError({}, makeSummary({ name: 'APIEmptyResponseError' }))).toBe(true);
  });

  it('returns false for unrelated error', () => {
    expect(isApiEmptyResponseError(new Error('boom'), makeSummary())).toBe(false);
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        fc.record({ name: fc.string(), message: fc.string(), code: fc.string() } as any),
        (error, summary) => {
          expect(() => isApiEmptyResponseError(error, summary as KimiErrorPayload)).not.toThrow();
          expect(typeof isApiEmptyResponseError(error, summary as KimiErrorPayload)).toBe('boolean');
        },
      ),
    );
  });
});

// ===========================================================================
// currentTurnInputTokens
// ===========================================================================

describe.concurrent('currentTurnInputTokens', () => {
  it('returns input total for a valid usage object', () => {
    const usage: TokenUsage = { inputOther: 80, output: 50, inputCacheRead: 15, inputCacheCreation: 5 };
    // inputTotal = inputOther + inputCacheRead + inputCacheCreation = 80+15+5 = 100
    expect(currentTurnInputTokens(usage)).toBe(100);
  });

  it('returns undefined for undefined usage', () => {
    expect(currentTurnInputTokens(undefined)).toBeUndefined();
  });

  it('returns 0 for zero-value usage', () => {
    const usage: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    expect(currentTurnInputTokens(usage)).toBe(0);
  });

  it('PBT: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            inputOther: fc.nat(),
            output: fc.nat(),
            inputCacheRead: fc.nat(),
            inputCacheCreation: fc.nat(),
          }),
          { nil: undefined },
        ),
        (usage) => {
          expect(() => currentTurnInputTokens(usage)).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// telemetryToolOutcome
// ===========================================================================

describe.concurrent('telemetryToolOutcome', () => {
  it('returns success when isError is false', () => {
    const result = { isError: false, output: 'ok' };
    expect(telemetryToolOutcome(result as any)).toBe('success');
  });

  it('returns cancelled when output contains aborted', () => {
    const result = { isError: true, output: [{ type: 'text', text: 'Command aborted by user' }] };
    expect(telemetryToolOutcome(result as any)).toBe('cancelled');
  });

  it('returns cancelled when output contains cancelled', () => {
    const result = { isError: true, output: 'Operation cancelled' };
    expect(telemetryToolOutcome(result as any)).toBe('cancelled');
  });

  it('returns cancelled when output contains manually interrupted', () => {
    const result = { isError: true, output: 'manually interrupted' };
    expect(telemetryToolOutcome(result as any)).toBe('cancelled');
  });

  it('returns error for other error output', () => {
    const result = { isError: true, output: 'permission denied' };
    expect(telemetryToolOutcome(result as any)).toBe('error');
  });

  it('PBT: never throws on arbitrary result objects', () => {
    fc.assert(
      fc.property(
        fc.record({
          isError: fc.boolean(),
          output: fc.oneof(fc.string(), fc.constant([])),
        }),
        (result) => {
          expect(() => telemetryToolOutcome(result as any)).not.toThrow();
          expect(['success', 'error', 'cancelled']).toContain(telemetryToolOutcome(result as any));
        },
      ),
    );
  });
});

// ===========================================================================
// telemetryToolErrorType
// ===========================================================================

describe.concurrent('telemetryToolErrorType', () => {
  it('returns ToolNotFound for missing tool', () => {
    const result = { isError: true, output: 'Tool "foo" not found' };
    expect(telemetryToolErrorType(result as any)).toBe('ToolNotFound');
  });

  it('returns ToolInputError for invalid args', () => {
    const result = { isError: true, output: 'Invalid args for tool "bar"' };
    expect(telemetryToolErrorType(result as any)).toBe('ToolInputError');
  });

  it('returns HookError for prepareToolExecution failure', () => {
    const result = { isError: true, output: 'prepareToolExecution hook failed' };
    expect(telemetryToolErrorType(result as any)).toBe('HookError');
  });

  it('returns HookError for finalizeToolResult failure', () => {
    const result = { isError: true, output: 'finalizeToolResult hook failed' };
    expect(telemetryToolErrorType(result as any)).toBe('HookError');
  });

  it('returns ToolBlocked for blocked output', () => {
    const result = { isError: true, output: 'Tool call blocked by user' };
    expect(telemetryToolErrorType(result as any)).toBe('ToolBlocked');
  });

  it('returns ToolError as default', () => {
    const result = { isError: true, output: 'something went wrong' };
    expect(telemetryToolErrorType(result as any)).toBe('ToolError');
  });

  it('PBT: never throws on arbitrary result objects', () => {
    fc.assert(
      fc.property(
        fc.record({
          isError: fc.boolean(),
          output: fc.oneof(fc.string(), fc.constant([])),
        }),
        (result) => {
          expect(() => telemetryToolErrorType(result as any)).not.toThrow();
          expect(typeof telemetryToolErrorType(result as any)).toBe('string');
        },
      ),
    );
  });
});

// ===========================================================================
// toolResultText
// ===========================================================================

describe.concurrent('toolResultText', () => {
  it('returns string output directly', () => {
    const result = { isError: false, output: 'hello' };
    expect(toolResultText(result as any)).toBe('hello');
  });

  it('joins text parts from array output', () => {
    const result = {
      isError: false,
      output: [
        { type: 'text' as const, text: 'foo ' },
        { type: 'text' as const, text: 'bar' },
      ],
    };
    expect(toolResultText(result as any)).toBe('foo bar');
  });

  it('filters non-text parts', () => {
    const result = {
      isError: false,
      output: [
        { type: 'text' as const, text: 'result' },
        { type: 'image' as const, url: 'data:image/png;base64,abc' },
      ],
    } as any;
    expect(toolResultText(result)).toBe('result');
  });

  it('returns empty string for empty array', () => {
    const result = { isError: false, output: [] };
    expect(toolResultText(result as any)).toBe('');
  });

  it('PBT: never throws on arbitrary result objects', () => {
    fc.assert(
      fc.property(
        fc.record({
          isError: fc.boolean(),
          output: fc.oneof(fc.string(), fc.constant([])),
        }),
        (result) => {
          expect(() => toolResultText(result as any)).not.toThrow();
          expect(typeof toolResultText(result as any)).toBe('string');
        },
      ),
    );
  });
});
