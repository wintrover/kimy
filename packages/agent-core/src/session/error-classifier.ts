/**
 * Error classification for isolated error handling.
 *
 * Prevents 429→400 error cascades by classifying errors into distinct
 * categories, each with its own handling strategy.
 *
 * - rate_limit (429): triggers rate_limited phase transition
 * - client_error (400/404): config problem, reports to circuit breaker only
 * - transient (500/502/503/504/connection/timeout): retryable, no phase change
 * - fatal: unrecoverable, fail the attempt
 */

import { APIStatusError, isProviderRateLimitError, isRetryableGenerateError } from '@moonshot-ai/kosong';

export type ErrorClassificationType = 'rate_limit' | 'client_error' | 'transient' | 'fatal';

export interface ErrorClassification {
  readonly type: ErrorClassificationType;
  /** Only rate_limit errors should trigger the rate_limited phase transition */
  readonly shouldTransitionToRateLimited: boolean;
  /** The error is a 4xx client error (config issue, not transient) */
  readonly isClientError: boolean;
  /** Provider ID extracted from the error (if available) */
  readonly providerId?: string;
  /** HTTP status code (if available) */
  readonly statusCode?: number;
}

/**
 * Classify an error and determine the appropriate handling strategy.
 * This is a pure function: same error → same classification.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (isProviderRateLimitError(error)) {
    return {
      type: 'rate_limit',
      shouldTransitionToRateLimited: true,
      isClientError: false,
      statusCode: getStatusCode(error) ?? 429,
    };
  }

  if (is4xxClientError(error)) {
    return {
      type: 'client_error',
      shouldTransitionToRateLimited: false,
      isClientError: true,
      statusCode: getStatusCode(error),
    };
  }

  if (isRetryableGenerateError(error)) {
    return {
      type: 'transient',
      shouldTransitionToRateLimited: false,
      isClientError: false,
      statusCode: getStatusCode(error),
    };
  }

  return {
    type: 'fatal',
    shouldTransitionToRateLimited: false,
    isClientError: false,
    statusCode: getStatusCode(error),
  };
}

/** Check if an error is a 4xx client error (400, 401, 403, 404, etc.) but NOT 429 */
function is4xxClientError(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  return statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record['statusCode'] === 'number') return record['statusCode'] as number;
  if (typeof record['status'] === 'number') return record['status'] as number;
  return undefined;
}
