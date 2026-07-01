/**
 * CompleteTaskTool — sub-agents MUST call this tool to finish their work.
 *
 * The tool captures a structured result (status, summary, affected files) and
 * stores it internally so the TransactionManager can verify the reported files
 * against actual disk changes after execution completes.
 *
 * Calling this tool sets `stopTurn = true` so the agent loop ends after the
 * result is recorded.
 */

import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { ZodToolBase } from '../../support/zod-tool-base';

// ── Schema ───────────────────────────────────────────────────────────

const CompleteTaskSchema = z.object({
  status: z.enum(['success', 'partial', 'failed']),
  summary: z
    .string()
    .min(1)
    .max(500)
    .describe('Concise outcome in 2-5 sentences. No code or logs.'),
  affectedFiles: z
    .array(z.string())
    .max(50)
    .optional()
    .describe(
      'EVERY file you created, modified, or deleted. Must be EXACT — framework verifies against disk. Missing or extra files = transaction ABORT.',
    ),
  keyFindings: z
    .array(z.string().max(200))
    .max(10)
    .optional()
    .describe('Key findings (explore/plan agents)'),
});

export type CompleteTaskInput = z.infer<typeof CompleteTaskSchema>;

/**
 * Sentinel key stored on the Agent records log to identify a completed task
 * result for extraction by the TransactionManager.
 */
export const COMPLETE_TASK_RESULT_KEY = '__complete_task_result__';

// ── Result type ──────────────────────────────────────────────────────

export interface CompleteTaskResult {
  readonly status: 'success' | 'partial' | 'failed';
  readonly summary: string;
  readonly affectedFiles: readonly string[];
  readonly keyFindings: readonly string[];
}

// ── Module-level result store ────────────────────────────────────────
// WeakMap lets the TransactionManager read the result after execution
// completes without needing a direct reference to the tool instance.

const agentResults = new WeakMap<Agent, CompleteTaskResult>();

/** Read the last CompleteTask result for an agent (if any). */
export function getCompleteTaskResult(agent: Agent): CompleteTaskResult | undefined {
  return agentResults.get(agent);
}

// ── Tool class ───────────────────────────────────────────────────────

export class CompleteTaskTool extends ZodToolBase<typeof CompleteTaskSchema> {
  readonly schema = CompleteTaskSchema;
  readonly name = 'CompleteTask';
  readonly description =
    'MANDATORY: Call this tool to finish your work. Your affectedFiles will be verified against actual disk changes. Do NOT end your turn with a plain text message.';

  /**
   * The most recent result captured by this tool. The TransactionManager
   * reads this after the agent execution completes.
   */
  private _lastResult: CompleteTaskResult | undefined;

  get lastResult(): CompleteTaskResult | undefined {
    return this._lastResult;
  }

  constructor(private readonly agent: Agent) {
    super();
  }

  resolveExecution(input: CompleteTaskInput): ToolExecution {
    const result: CompleteTaskResult = {
      status: input.status,
      summary: input.summary,
      affectedFiles: input.affectedFiles ?? [],
      keyFindings: input.keyFindings ?? [],
    };
    this._lastResult = result;
    agentResults.set(this.agent, result);

    // Also log to agent records so the result is persisted.
    this.agent.records.logRecord({
      type: COMPLETE_TASK_RESULT_KEY as never,
      ...input,
    } as never);

    return {
      approvalRule: this.name,
      stopBatchAfterThis: true,
      execute: async (): Promise<ExecutableToolResult> => ({
        output: 'Task completed. Result captured and will be verified.',
        stopTurn: true,
      }),
    };
  }
}
