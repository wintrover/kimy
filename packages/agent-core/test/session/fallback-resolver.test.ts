import { describe, it, expect } from 'vitest';
import { getEffectiveFallbackModel } from '#/session/fallback-resolver';

describe('getEffectiveFallbackModel', () => {
  it('returns config fallback when both are provided', () => {
    expect(getEffectiveFallbackModel('mimo-v2.5', 'other')).toBe('mimo-v2.5');
  });

  it('returns config fallback when context is undefined', () => {
    expect(getEffectiveFallbackModel('mimo-v2.5', undefined)).toBe('mimo-v2.5');
  });

  it('returns context fallback when config is undefined', () => {
    expect(getEffectiveFallbackModel(undefined, 'mimo-v2.5')).toBe('mimo-v2.5');
  });

  it('returns undefined when both are undefined', () => {
    expect(getEffectiveFallbackModel(undefined, undefined)).toBeUndefined();
  });

  it('falls back to context when config is whitespace only', () => {
    expect(getEffectiveFallbackModel('   ', 'mimo-v2.5')).toBe('mimo-v2.5');
  });

  it('falls back to context when config is empty string', () => {
    expect(getEffectiveFallbackModel('', 'mimo-v2.5')).toBe('mimo-v2.5');
  });
});
