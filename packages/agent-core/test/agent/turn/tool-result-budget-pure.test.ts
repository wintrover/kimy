import { describe, expect, it } from 'vitest';

import {
  persistableToolResultText,
  renderPersistedToolResult,
  safeToolResultFileStem,
} from '../../../src/agent/turn/tool-result-budget-pure';

describe.concurrent('persistableToolResultText', () => {
  it('returns the string directly when output is a plain string', () => {
    expect(persistableToolResultText('hello')).toBe('hello');
  });

  it('joins text parts from an array of text-only parts', () => {
    const parts = [
      { type: 'text' as const, text: 'hello ' },
      { type: 'text' as const, text: 'world' },
    ];
    expect(persistableToolResultText(parts)).toBe('hello world');
  });

  it('returns undefined when output contains non-text parts', () => {
    const parts = [
      { type: 'text' as const, text: 'hello' },
      { type: 'image' as const, url: 'data:image/png;base64,abc' },
    ] as any;
    expect(persistableToolResultText(parts)).toBeUndefined();
  });

  it('returns empty string for null input', () => {
    expect(persistableToolResultText(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(persistableToolResultText(undefined)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(persistableToolResultText('')).toBe('');
  });

  it('returns empty string for empty array input', () => {
    expect(persistableToolResultText([])).toBe('');
  });
});

describe.concurrent('renderPersistedToolResult', () => {
  it('includes tool name and call id in the output', () => {
    const result = renderPersistedToolResult(
      'my-tool',
      'call-1',
      'output text',
      '/path/to/file',
    );
    expect(result).toContain('tool_name: my-tool');
    expect(result).toContain('tool_call_id: call-1');
  });

  it('reports output size in characters and bytes', () => {
    const text = 'hello';
    const result = renderPersistedToolResult('t', 'c', text, '/p');
    expect(result).toContain('output_size_chars: 5');
    expect(result).toContain('output_size_bytes: 5');
  });

  it('includes output path and a preview section', () => {
    const result = renderPersistedToolResult('t', 'c', 'some text', '/my/path');
    expect(result).toContain('output_path: /my/path');
    expect(result).toContain('[preview]');
    expect(result).toContain('some text');
  });

  it('truncates preview to at most 2000 characters', () => {
    const longText = 'x'.repeat(5000);
    const result = renderPersistedToolResult('t', 'c', longText, '/p');
    expect(result).toContain('x'.repeat(2000));
    expect(result).not.toContain('x'.repeat(2001));
  });

  it('handles multibyte characters correctly in byte count', () => {
    const text = '\u4e16\u754c'; // "世界" — 6 bytes in UTF-8
    const result = renderPersistedToolResult('t', 'c', text, '/p');
    expect(result).toContain('output_size_chars: 2');
    expect(result).toContain('output_size_bytes: 6');
  });
});

describe.concurrent('safeToolResultFileStem', () => {
  it('sanitizes special characters to underscores', () => {
    const stem = safeToolResultFileStem('my tool!', 'call id');
    expect(stem).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('truncates result to at most 80 characters', () => {
    const longName = 'a'.repeat(100);
    const stem = safeToolResultFileStem(longName, 'id');
    expect(stem.length).toBeLessThanOrEqual(80);
  });

  it('returns untitled-based stem for empty string inputs', () => {
    expect(safeToolResultFileStem('', '')).toBe('untitled-untitled');
  });

  it('returns a non-empty string for null inputs', () => {
    const stem = safeToolResultFileStem(null, null);
    expect(stem.length).toBeGreaterThan(0);
  });

  it('returns a non-empty string for undefined inputs', () => {
    const stem = safeToolResultFileStem(undefined, undefined);
    expect(stem.length).toBeGreaterThan(0);
  });

  it('preserves dots, dashes, and underscores', () => {
    const stem = safeToolResultFileStem('my-tool.v2', 'run_1');
    expect(stem).toBe('my-tool.v2-run_1');
  });

  it('PBT: never throws and always returns a non-empty string', () => {
    const inputs: Array<[string | null | undefined, string | null | undefined]> = [
      ['', ''],
      [null, null],
      [undefined, undefined],
      [' ', ' '],
      ['\n\t\r', '\n\t\r'],
      ['!!!@@@###', '$$$%%%^^^'],
      ['a'.repeat(1000), 'b'.repeat(1000)],
      ['../../etc/passwd', '../../etc/shadow'],
      ['tool-name_1.0', 'call_123'],
      [null, ''],
      ['', undefined],
    ];
    for (const [tn, tc] of inputs) {
      expect(() => safeToolResultFileStem(tn, tc)).not.toThrow();
      const result = safeToolResultFileStem(tn, tc);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
