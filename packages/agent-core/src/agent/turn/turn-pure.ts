/**
 * Pure functions extracted from the turn module.
 *
 * These are stateless transforms over plain data — no side effects, no class
 * dependencies. They are the Stage-1 source for future Nim code generation
 * (see EffectMarker below).
 *
 * Architectural principles enforced here:
 *   A. Total Function Enforcement — no `throw`; every branch returns.
 *   B. AST-Friendly Syntax — only static if/else, switch/case, destructuring,
 *      and object-literal returns.
 *   C. Data, Not Code — return serializable PODs, never callbacks/promises.
 *   D. Effect Type Markers — `_effect` marker on return types for Stage-2 Nim.
 */

import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  inputTotal,
  isContextOverflowStatusError,
  type TokenUsage,
} from '@moonshot-ai/kosong';
import {
  ErrorCodes,
  type KimiErrorPayload,
  toKimiErrorPayload,
} from '#/errors';
import type {
  ExecutableToolResult,
  LoopEvent,
  LoopTurnInterruptedEvent,
} from '../../loop/index';
import type { AgentEvent } from '../../rpc';
import type { PromptOrigin } from '../context';
import { isPlainRecord } from './canonical-args';

// ---------------------------------------------------------------------------
// Constants (duplicated from the turn module to keep this file self-contained)
// ---------------------------------------------------------------------------

const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion';
const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked';
const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';

// ---------------------------------------------------------------------------
// Effect marker (Principle D)
// ---------------------------------------------------------------------------

/**
 * Stage-2 marker: signals whether a return value can logically trigger a side
 * effect.  Every function in this module is pure today, so the marker is
 * always `'NONE'`.  The type exists so that future Nim bindings can pattern-
 * match on it.
 */
export type EffectMarker = { _effect?: 'NONE' | 'READ_FILE' | 'SEND_EVENT' | 'CALL_TOOL' };

// ---------------------------------------------------------------------------
// Shared local types
// ---------------------------------------------------------------------------

export interface ApiErrorClassification extends EffectMarker {
  readonly errorType: string;
  readonly statusCode?: number;
}

type ToolTelemetryResult = Extract<LoopEvent, { type: 'tool.result' }>['result'];

// ---------------------------------------------------------------------------
// Goal / budget helpers
// ---------------------------------------------------------------------------

export function isGoalOutcomeReminderOrigin(origin: PromptOrigin | undefined): boolean {
  return (
    origin?.kind === 'system_trigger' &&
    (origin.name === GOAL_COMPLETION_REMINDER_NAME ||
      origin.name === GOAL_BLOCKED_REMINDER_NAME)
  );
}

export function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

export function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
    // Principle A: total — every exhaustive union branch must have a default
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Error summarisation
// ---------------------------------------------------------------------------

export function summarizeTurnError(error: unknown, turnId: number): KimiErrorPayload & EffectMarker {
  const payload = toKimiErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details, _effect: 'NONE' };
  }

  return { ...payload, details, _effect: 'NONE' };
}

// ---------------------------------------------------------------------------
// Goal pause reasons
// ---------------------------------------------------------------------------

export function goalFailurePauseReason(error: KimiErrorPayload | undefined): string {
  if (error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) return GOAL_RATE_LIMIT_PAUSE_REASON;
  if (error?.code === ErrorCodes.PROVIDER_CONNECTION_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_AUTH_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_API_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_API_PAUSE_PREFIX, error.message);
  }
  if (
    error?.code === ErrorCodes.MODEL_NOT_CONFIGURED ||
    error?.code === ErrorCodes.MODEL_CONFIG_INVALID
  ) {
    return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, error.message);
  }
  return pauseReasonWithMessage(GOAL_RUNTIME_PAUSE_PREFIX, error?.message);
}

export function pauseReasonWithMessage(prefix: string, message: string | undefined): string {
  return message === undefined || message.length === 0 ? prefix : `${prefix}: ${message}`;
}

// ---------------------------------------------------------------------------
// Tool I/O helpers
// ---------------------------------------------------------------------------

export function toolInputRecord(args: unknown): Record<string, unknown> {
  return isPlainRecord(args) ? args : {};
}

export function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

export function interruptedStep(event: LoopTurnInterruptedEvent): number {
  return event.activeStep ?? event.attemptedSteps;
}

// ---------------------------------------------------------------------------
// API error classification (Principle A — total, no throw)
// ---------------------------------------------------------------------------

export function classifyApiError(error: unknown, summary: KimiErrorPayload): ApiErrorClassification {
  const statusCode = apiStatusCode(error) ?? summaryStatusCode(summary);
  if (statusCode !== undefined) {
    if (statusCode === 429) return { errorType: 'rate_limit', statusCode, _effect: 'NONE' };
    if (statusCode === 401 || statusCode === 403) return { errorType: 'auth', statusCode, _effect: 'NONE' };
    if (statusCode >= 500) return { errorType: '5xx_server', statusCode, _effect: 'NONE' };
    if (isContextOverflowStatusError(statusCode, summary.message)) {
      return { errorType: 'context_overflow', statusCode, _effect: 'NONE' };
    }
    if (statusCode >= 400) return { errorType: '4xx_client', statusCode, _effect: 'NONE' };
    return { errorType: 'api', statusCode, _effect: 'NONE' };
  }

  if (summary.code === ErrorCodes.PROVIDER_RATE_LIMIT) return { errorType: 'rate_limit', _effect: 'NONE' };
  if (summary.code === ErrorCodes.PROVIDER_AUTH_ERROR) return { errorType: 'auth', _effect: 'NONE' };
  if (summary.code === ErrorCodes.CONTEXT_OVERFLOW) return { errorType: 'context_overflow', _effect: 'NONE' };
  if (isApiConnectionError(error, summary)) return { errorType: 'network', _effect: 'NONE' };
  if (isApiTimeoutError(error, summary)) return { errorType: 'timeout', _effect: 'NONE' };
  if (isApiEmptyResponseError(error, summary)) return { errorType: 'empty_response', _effect: 'NONE' };
  return { errorType: 'other', _effect: 'NONE' };
}

export function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function summaryStatusCode(summary: KimiErrorPayload): number | undefined {
  const statusCode = summary.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

export function isApiConnectionError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIConnectionError || summary.name === 'APIConnectionError';
}

export function isApiTimeoutError(error: unknown, summary: KimiErrorPayload): boolean {
  return (
    error instanceof APITimeoutError ||
    summary.name === 'APITimeoutError' ||
    summary.name === 'TimeoutError'
  );
}

export function isApiEmptyResponseError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIEmptyResponseError || summary.name === 'APIEmptyResponseError';
}

// ---------------------------------------------------------------------------
// Token / telemetry helpers
// ---------------------------------------------------------------------------

export function currentTurnInputTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  return inputTotal(usage);
}

export function telemetryToolOutcome(result: ToolTelemetryResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolResultText(result).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

export function telemetryToolErrorType(result: ToolTelemetryResult): string {
  const text = toolResultText(result);
  if (text.startsWith('Tool "') && text.includes('" not found')) return 'ToolNotFound';
  if (text.startsWith('Invalid args for tool "')) return 'ToolInputError';
  if (text.includes('prepareToolExecution hook failed')) return 'HookError';
  if (text.includes('finalizeToolResult hook failed')) return 'HookError';
  if (text.includes('blocked')) return 'ToolBlocked';
  return 'ToolError';
}

export function toolResultText(result: ToolTelemetryResult): string {
  return toolOutputText(result.output);
}
