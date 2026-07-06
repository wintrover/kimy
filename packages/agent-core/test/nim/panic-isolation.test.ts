import { describe, it, expect } from 'vitest';
import { NimErrorCode } from '../../src/nim/types.js';

describe('Panic Isolation — Error Code Schema', () => {
  it('should define all error codes matching Nim constants', () => {
    expect(NimErrorCode.ERR_BUFFER_TOO_SHORT).toBe(-1);
    expect(NimErrorCode.ERR_MAGIC_MISMATCH).toBe(-2);
    expect(NimErrorCode.ERR_LENGTH_OVERFLOW).toBe(-3);
    expect(NimErrorCode.ERR_CATCHABLE).toBe(-998);
    expect(NimErrorCode.ERR_PANIC).toBe(-999);
  });

  it('should distinguish success from error codes', () => {
    const successCodes = [0, 1, 42, 100, 9999];
    const errorCodes = [
      NimErrorCode.ERR_BUFFER_TOO_SHORT,
      NimErrorCode.ERR_MAGIC_MISMATCH,
      NimErrorCode.ERR_LENGTH_OVERFLOW,
      NimErrorCode.ERR_CATCHABLE,
      NimErrorCode.ERR_PANIC,
    ];

    for (const code of successCodes) {
      expect(code >= 0).toBe(true);
    }
    for (const code of errorCodes) {
      expect(code < 0).toBe(true);
    }
  });

  it('should have panic code as most negative (-999)', () => {
    expect(NimErrorCode.ERR_PANIC).toBeLessThan(NimErrorCode.ERR_CATCHABLE);
    expect(NimErrorCode.ERR_CATCHABLE).toBeLessThan(NimErrorCode.ERR_LENGTH_OVERFLOW);
    expect(NimErrorCode.ERR_LENGTH_OVERFLOW).toBeLessThan(NimErrorCode.ERR_MAGIC_MISMATCH);
    expect(NimErrorCode.ERR_MAGIC_MISMATCH).toBeLessThan(NimErrorCode.ERR_BUFFER_TOO_SHORT);
    expect(NimErrorCode.ERR_BUFFER_TOO_SHORT).toBeLessThan(0);
  });

  it('should have sufficient gap between catchable and panic codes', () => {
    // -998 and -999 are adjacent but distinct
    const gap = NimErrorCode.ERR_CATCHABLE - NimErrorCode.ERR_PANIC;
    expect(gap).toBe(1);
  });
});

describe('Panic Isolation — Buffer Validation Pipeline', () => {
  /** Simulate the full validation pipeline as Nim would execute. */
  function simulateValidation(data: Uint8Array): number {
    // Step 1: Length check
    if (data.length < 8) return NimErrorCode.ERR_BUFFER_TOO_SHORT;
    // Step 2: Magic number check
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x4158494D) return NimErrorCode.ERR_MAGIC_MISMATCH;
    // Step 3: Length overflow check
    const totalLen = view.getInt32(4, true);
    if (totalLen > data.length) return NimErrorCode.ERR_LENGTH_OVERFLOW;
    // Step 4: Payload processing (simulated)
    return 0; // success
  }

  it('should catch too-short buffer before magic check', () => {
    const result = simulateValidation(new Uint8Array(4));
    expect(result).toBe(NimErrorCode.ERR_BUFFER_TOO_SHORT);
  });

  it('should catch bad magic before length check', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x00000000, true);
    view.setInt32(4, 16, true);
    const result = simulateValidation(buf);
    expect(result).toBe(NimErrorCode.ERR_MAGIC_MISMATCH);
  });

  it('should catch length overflow after magic check', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x4158494D, true);
    view.setInt32(4, 999, true);
    const result = simulateValidation(buf);
    expect(result).toBe(NimErrorCode.ERR_LENGTH_OVERFLOW);
  });

  it('should succeed on valid input', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x4158494D, true);
    view.setInt32(4, 16, true);
    view.setInt32(8, 42, true); // payload
    view.setInt32(12, 0, true); // padding
    const result = simulateValidation(buf);
    expect(result).toBe(0);
  });
});
