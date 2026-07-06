import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { join } from 'pathe';

import type { ExecutableToolResult } from '../../loop';
import {
  persistableToolResultText,
  renderPersistedToolResult,
  safeToolResultFileStem,
} from './tool-result-budget-pure';

export { persistableToolResultText, renderPersistedToolResult, safeToolResultFileStem } from './tool-result-budget-pure';

const TOOL_RESULT_MAX_CHARS = 50_000;

interface BudgetToolResultOptions {
  readonly homedir?: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: ExecutableToolResult;
}

export async function budgetToolResultForModel(
  options: BudgetToolResultOptions,
): Promise<ExecutableToolResult> {
  const text = persistableToolResultText(options.result.output);
  if (text === undefined || text.length <= TOOL_RESULT_MAX_CHARS) return options.result;
  if (options.result.truncated === true) return options.result;
  if (options.homedir === undefined) return options.result;

  const outputPath = await saveToolResult(
    { homedir: options.homedir, toolName: options.toolName, toolCallId: options.toolCallId },
    text,
  );
  if (outputPath === undefined) return options.result;
  const output = renderPersistedToolResult(options.toolName, options.toolCallId, text, outputPath);
  return options.result.isError === true
    ? { ...options.result, output, isError: true }
    : { ...options.result, output };
}

async function saveToolResult(
  options: { readonly homedir: string; readonly toolName: string; readonly toolCallId: string },
  text: string,
): Promise<string | undefined> {
  try {
    const dir = join(options.homedir, 'tool-results');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(
      dir,
      `${safeToolResultFileStem(options.toolName, options.toolCallId)}-${randomUUID()}.txt`,
    );
    await writeFile(outputPath, text, { encoding: 'utf8', flag: 'wx' });
    return outputPath;
  } catch {
    return undefined;
  }
}

