import { describe, it, expect } from 'vitest';
import { AXIM_MAGIC, HEADER_SIZE } from '../../src/nim/types.js';

/** Simulate the Nim-side header validation in TypeScript for testing. */
function validateHeader(data: Uint8Array): number {
  if (data.length < HEADER_SIZE) return -1; // ERR_BUFFER_TOO_SHORT
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== AXIM_MAGIC) return -2; // ERR_MAGIC_MISMATCH
  const totalLen = view.getInt32(4, true);
  if (totalLen > data.length || totalLen < HEADER_SIZE) return -3; // ERR_LENGTH_OVERFLOW
  return 0;
}

function writeValidFrame(target: Uint8Array, payload: Uint8Array): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(0, AXIM_MAGIC, true);
  view.setInt32(4, HEADER_SIZE + payload.length, true);
  target.set(payload, HEADER_SIZE);
}

describe('Segfault Guard — Header Validation', () => {
  it('should reject buffer shorter than 8 bytes (ERR_BUFFER_TOO_SHORT = -1)', () => {
    const tiny = new Uint8Array(4);
    expect(validateHeader(tiny)).toBe(-1);
  });

  it('should reject empty buffer', () => {
    const empty = new Uint8Array(0);
    expect(validateHeader(empty)).toBe(-1);
  });

  it('should reject wrong magic number (ERR_MAGIC_MISMATCH = -2)', () => {
    const bad = new Uint8Array(16);
    const view = new DataView(bad.buffer);
    view.setUint32(0, 0xDEADBEEF, true); // wrong magic
    view.setInt32(4, 16, true);
    expect(validateHeader(bad)).toBe(-2);
  });

  it('should reject length overflow (ERR_LENGTH_OVERFLOW = -3)', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, AXIM_MAGIC, true);
    view.setInt32(4, 9999, true); // length claims 9999 but buffer is only 16
    expect(validateHeader(buf)).toBe(-3);
  });

  it('should reject length smaller than header', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, AXIM_MAGIC, true);
    view.setInt32(4, 4, true); // length claims 4 but header is 8
    expect(validateHeader(buf)).toBe(-3);
  });

  it('should accept valid frame', () => {
    const buf = new Uint8Array(32);
    const payload = new Uint8Array([10, 0, 0, 0]);
    writeValidFrame(buf, payload);
    expect(validateHeader(buf)).toBe(0);
  });

  it('should accept exact-size frame', () => {
    const buf = new Uint8Array(12); // exactly header + 4 payload
    const payload = new Uint8Array([42, 0, 0, 0]);
    writeValidFrame(buf, payload);
    expect(validateHeader(buf)).toBe(0);
  });

  it('should handle maximum int32 payload size gracefully', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, AXIM_MAGIC, true);
    view.setInt32(4, 0x7FFFFFFF, true); // max int32
    expect(validateHeader(buf)).toBe(-3); // overflow
  });
});
