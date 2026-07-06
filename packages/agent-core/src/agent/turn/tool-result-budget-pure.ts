import type { ContentPart } from '@moonshot-ai/kosong';

import type { ExecutableToolResult } from '../../loop';

const TOOL_RESULT_MAX_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;

export function persistableToolResultText(
  output: ExecutableToolResult['output'] | null | undefined,
): string | undefined {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (
    !output.every(
      (part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text',
    )
  ) {
    return undefined;
  }
  return output.map((part) => part.text).join('');
}

export function renderPersistedToolResult(
  toolName: string,
  toolCallId: string,
  text: string,
  outputPath: string,
): string {
  const lines = [
    'Tool output exceeded ' + String(TOOL_RESULT_MAX_CHARS) + ' characters; showing a preview only.',
    'tool_name: ' + toolName,
    'tool_call_id: ' + toolCallId,
    'output_size_chars: ' + String(text.length),
    'output_size_bytes: ' + String(Buffer.byteLength(text, 'utf8')),
    'output_path: ' + outputPath,
    'next_step: Use Read with output_path to page through the full output.',
  ];
  lines.push('', '[preview]', text.slice(0, TOOL_RESULT_PREVIEW_CHARS));
  return lines.join('\n');
}

export function safeToolResultFileStem(
  toolName: string | null | undefined,
  toolCallId: string | null | undefined,
): string {
  var tn = toolName !== null && toolName !== undefined && toolName !== '' ? toolName : 'untitled';
  var tc = toolCallId !== null && toolCallId !== undefined && toolCallId !== '' ? toolCallId : 'untitled';
  var label = (tn + '-' + tc)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return label || 'untitled';
}
