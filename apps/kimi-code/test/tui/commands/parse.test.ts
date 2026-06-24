import { describe, expect, it } from 'vitest';
import { parseSlashInput } from '#/tui/commands/parse';

describe('parseSlashInput', () => {
  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello')).toBeNull();
  });

  it('returns null for bare slash', () => {
    expect(parseSlashInput('/')).toBeNull();
  });

  it('returns null for slash with only whitespace', () => {
    expect(parseSlashInput('/   ')).toBeNull();
  });

  it('parses command without args', () => {
    expect(parseSlashInput('/login')).toEqual({ name: 'login', args: '' });
  });

  it('parses command with args', () => {
    expect(parseSlashInput('/model gpt-4')).toEqual({ name: 'model', args: 'gpt-4' });
  });

  it('trims leading whitespace in args', () => {
    expect(parseSlashInput('/test   hello world')).toEqual({ name: 'test', args: 'hello world' });
  });

  it('returns null for nested slash in command name', () => {
    expect(parseSlashInput('/foo/bar')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseSlashInput('')).toBeNull();
  });
});
