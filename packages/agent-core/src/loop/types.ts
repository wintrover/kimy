/**
 * Public contracts for the stateless agent loop.
 *
 * This file defines the narrow surfaces that connect a Kosong conversation to
 * tool execution, phase hooks, and turn results. Host-layer metadata, policy,
 * archival limits, and UI concerns stay outside these contracts.
 *
 * Field naming is camelCase unless a reused Kosong type says otherwise.
 * Optional fields use `?: T | undefined` intentionally under
 * `exactOptionalPropertyTypes: true`.
 */

import type { ContentPart, Message, TokenUsage, Tool, ToolCall } from '@moonshot-ai/kosong';

import type { MCPToolAnnotations } from '../mcp/types';
import type { ToolInputDisplay } from '../tools/display';
import type { ToolAccesses } from './tool-access';
import type { LLM } from './llm';

export type { ToolCall };

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

/**
 * Stop reason for one completed model step.
 *
 * `tool_use` is a loop-control signal: the loop executes the requested tools and
 * continues with another step. The other values are terminal for the current
 * turn unless a host hook explicitly asks the loop to continue.
 */
export type LoopStepStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'filtered'
  | 'paused'
  | 'unknown'
  | 'safety_recovered';

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, 'tool_use'>;

/**
 * Stop reasons that can be returned in a normal `TurnResult`.
 *
 * `tool_use` is intentionally absent because it cannot be the final result of a
 * completed turn. Errors and max-step exhaustion are represented by thrown
 * errors, not by this union. Compaction is a host-level retry concern rather
 * than a stop reason.
 */
export type LoopTurnStopReason = LoopTerminalStepStopReason | 'aborted';

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
  usage: TokenUsage;
}

export type ExecutableToolOutput = string | ContentPart[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  /**
   * Internal loop-control hint. Tool result events strip this field before
   * persistence; it only tells the current turn whether another model step or
   * later tool calls in the same batch are allowed.
   */
  readonly stopTurn?: boolean | undefined;
  /**
   * Optional human-readable side channel for tool-result metadata that
   * should not contaminate the data stream the model sees (e.g. a
   * "Task snapshot retrieved." brief for TaskOutput). Distinct from
   * `output`: callers rendering tool results decide whether to surface
   * this to the user.
   */
  readonly message?: string | undefined;
  /**
   * Why the process exited. Propagated from the shell tool so downstream
   * consumers (e.g. circuit-breaker) can distinguish timeout kills from
   * normal errors and decide whether to invalidate stale fingerprints.
   */
  readonly exitReason?: 'timeout' | 'signal' | 'normal' | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  /** See {@link ExecutableToolSuccessResult.message}. */
  readonly message?: string | undefined;
  /** See {@link ExecutableToolSuccessResult.stopTurn}. */
  readonly stopTurn?: boolean | undefined;
  /** See {@link ExecutableToolSuccessResult.exitReason}. */
  readonly exitReason?: 'timeout' | 'signal' | 'normal' | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  /** Vendor-defined event identifier when `kind === 'custom'`. */
  customKind?: string | undefined;
  /** Opaque payload paired with `customKind`. */
  customData?: unknown;
}

/**
 * Per-call context passed to tool implementations.
 */
export interface ExecutableToolContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
  /** Agent environment snapshot (read-only). Tools cannot modify this directly. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  /**
   * Stops scheduling later tool calls in the same provider batch. Use this only
   * for tools whose successful action changes turn lifecycle state.
   */
  readonly stopBatchAfterThis?: boolean | undefined;
  readonly approvalRule: string;
  readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool<Input = unknown> extends Tool {
  /** Optional MCP tool annotations propagated from the originating MCP server. */
  annotations?: MCPToolAnnotations;
  resolveExecution(input: Input): ToolExecution | Promise<ToolExecution>;
  /**
   * Pre-validation alias normalizer. Called before AJV validation so that
   * the validator only ever sees canonical parameter names.
   *
   * Return type is strictly `Record<string, unknown>` to guarantee no data
   * loss through the normalization step.
   */
  normalizeArgs?(args: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Step hooks are aligned to recorded phase boundaries: `beforeStep` runs before
 * `step.begin`, while `afterStep` runs after `step.end`.
 */

export interface LoopStepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly llm: LLM;
}

export interface ToolExecutionHookContext extends LoopStepHookContext {
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly syntheticResult?: ExecutableToolResult | undefined;
  readonly executionMetadata?: unknown;
}

export interface PrepareToolExecutionResult extends AuthorizeToolExecutionResult {
  readonly updatedArgs?: unknown;
}

export interface FinalizeToolResultContext extends ToolExecutionHookContext {
  readonly result: ExecutableToolResult;
}

export interface LoopAfterStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}

export interface LoopStoppedStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopTerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface AfterStepResult {
  readonly stopTurn?: boolean | undefined;
}

export interface RecordStepUsageResult {
  /**
   * Internal loop-control hint. Hosts can return this after recording usage
   * when the completed model step has reached a hard runtime limit.
   */
  readonly stopTurn?: boolean | undefined;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

export type BeforeStepHook = (ctx: LoopStepHookContext) => Promise<BeforeStepResult | undefined>;

export type AfterStepHook = (ctx: LoopAfterStepContext) => Promise<AfterStepResult | void>;

export type PrepareToolExecutionHook = (
  ctx: ToolExecutionHookContext,
) => Promise<PrepareToolExecutionResult | undefined>;

export type AuthorizeToolExecutionHook = (
  ctx: ResolvedToolExecutionHookContext,
) => Promise<AuthorizeToolExecutionResult | undefined>;

export type FinalizeToolResultHook = (
  ctx: FinalizeToolResultContext,
) => Promise<ExecutableToolResult | undefined>;

export type ShouldContinueAfterStopHook = (
  ctx: LoopStoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;

export interface LoopBeforeToolBatchContext extends LoopStepHookContext {
  readonly toolCalls: readonly ToolCall[];
}

export type BeforeToolBatchHook = (
  ctx: LoopBeforeToolBatchContext,
) => Promise<void>;

export interface LoopAfterToolBatchContext extends LoopStepHookContext {
  readonly toolCalls: readonly ToolCall[];
  readonly results: readonly ExecutableToolResult[];
  readonly swarmReorderReminder?: string | undefined;
}

export type AfterToolBatchHook = (
  ctx: LoopAfterToolBatchContext,
) => Promise<void>;

/**
 * Groups every awaited phase hook.
 *
 * Hooks can affect control flow at deterministic transcript points. Event
 * listeners observe output and cannot change turn behavior.
 *
 * Tool hooks run serially in provider tool-call order before the matching
 * durable event is recorded, so preparation and finalization decisions are
 * resolved at stable transcript points.
 */
export interface LoopHooks {
  beforeStep?: BeforeStepHook | undefined;
  afterStep?: AfterStepHook | undefined;
  beforeToolBatch?: BeforeToolBatchHook | undefined;
  afterToolBatch?: AfterToolBatchHook | undefined;
  prepareToolExecution?: PrepareToolExecutionHook | undefined;
  authorizeToolExecution?: AuthorizeToolExecutionHook | undefined;
  finalizeToolResult?: FinalizeToolResultHook | undefined;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook | undefined;
}
