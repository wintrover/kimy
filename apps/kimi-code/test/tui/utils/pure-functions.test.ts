import { describe, expect, it } from 'vitest';
import { isAbortError } from '#/tui/utils/errors';
import { hasPatchChanges } from '#/tui/utils/object-patch';
import { OAUTH_LOGIN_REQUIRED_CODE } from '#/constant/app';
import { combineStartupNotice, isOAuthLoginRequiredError } from '#/tui/utils/startup';

describe('isAbortError', () => {
  it('returns true for Error with name AbortError', () => {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });

  it('returns true for Error with message "Aborted"', () => {
    expect(isAbortError(new Error('Aborted'))).toBe(true);
  });

  it('returns true for Error with message ending in ": Aborted"', () => {
    expect(isAbortError(new Error('fetch: Aborted'))).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isAbortError(new Error('something else'))).toBe(false);
  });

  it('returns true for object-like error with abort message', () => {
    expect(isAbortError({ message: 'Aborted' })).toBe(true);
  });

  it('returns false for object-like error with non-abort message', () => {
    expect(isAbortError({ message: 'nope' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAbortError(null)).toBe(false);
  });

  it('returns true for string "Aborted"', () => {
    expect(isAbortError('Aborted')).toBe(true);
  });

  it('returns false for unrelated string', () => {
    expect(isAbortError('timeout')).toBe(false);
  });
});

describe('hasPatchChanges', () => {
  it('returns true when patch changes a value', () => {
    expect(hasPatchChanges({ a: 1, b: 2 }, { a: 2 })).toBe(true);
  });

  it('returns false when patch values are identical', () => {
    expect(hasPatchChanges({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('returns false for empty patch', () => {
    expect(hasPatchChanges({ a: 1 }, {})).toBe(false);
  });

  it('handles undefined values correctly', () => {
    expect(hasPatchChanges({ a: undefined }, { a: undefined })).toBe(false);
    expect(hasPatchChanges({ a: undefined }, { a: 1 })).toBe(true);
  });

  it('uses Object.is semantics (NaN is not NaN, +0 is not -0)', () => {
    expect(hasPatchChanges({ a: NaN }, { a: NaN })).toBe(false);
    // Object.is(0, -0) is false, so this IS a change
    expect(hasPatchChanges({ a: 0 }, { a: -0 })).toBe(true);
  });
});

describe('combineStartupNotice', () => {
  it('combines two messages with newline', () => {
    expect(combineStartupNotice('a', 'b')).toBe('a\nb');
  });

  it('returns next when existing is undefined', () => {
    expect(combineStartupNotice(undefined, 'b')).toBe('b');
  });

  it('returns existing when next is undefined', () => {
    expect(combineStartupNotice('a', undefined)).toBe('a');
  });

  it('returns undefined when both are undefined', () => {
    expect(combineStartupNotice(undefined, undefined)).toBeUndefined();
  });
});

describe('isOAuthLoginRequiredError', () => {
  it('returns true for error with matching code', () => {
    expect(isOAuthLoginRequiredError({ code: OAUTH_LOGIN_REQUIRED_CODE })).toBe(true);
  });

  it('returns false for error with different code', () => {
    expect(isOAuthLoginRequiredError({ code: 'OTHER' })).toBe(false);
  });

  it('returns false for error without code', () => {
    expect(isOAuthLoginRequiredError({})).toBe(false);
  });
});
