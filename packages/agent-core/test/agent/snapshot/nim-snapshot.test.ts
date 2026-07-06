import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AXIM_MAGIC } from '../../../src/nim/types.js';

// Detect native addon — skip tests if not built.
const __testDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const addonPath = resolve(
  __testDir,
  '../../../native/node/build/Release/nim_agent_core.node',
);
const nativeAvailable = existsSync(addonPath);
const describeNative = nativeAvailable ? describe : describe.skip;

/** Build a valid AXIM frame around a UTF-8 payload string. */
function makeAximFrame(payload: string): Uint8Array {
  const payloadBytes = new TextEncoder().encode(payload);
  const frame = new Uint8Array(8 + payloadBytes.length);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, AXIM_MAGIC, true);
  dv.setInt32(4, frame.length, true);
  frame.set(payloadBytes, 8);
  return frame;
}

describeNative('Nim Snapshot Procs', () => {
  let addon: any;

  it('should load native addon', () => {
    // Use createRequire to bypass vitest ESM import-transform issues
    const require2 = createRequire(import.meta.url);
    addon = require2(addonPath);
    expect(addon).toBeDefined();
    expect(typeof addon.validateSnapshot).toBe('function');
    expect(typeof addon.computeStateHash).toBe('function');
    expect(typeof addon.applyEvents).toBe('function');
    expect(typeof addon.migrateSnapshot).toBe('function');
  });

  // --- validateSnapshot ---

  it('validateSnapshot returns 0 for valid AXIM+JSON', () => {
    const frame = makeAximFrame('{"test":1}');
    expect(addon.validateSnapshot(frame)).toBe(0);
  });

  it('validateSnapshot throws for bad magic', () => {
    const frame = makeAximFrame('{"test":1}');
    new DataView(frame.buffer).setUint32(0, 0xdeadbeef, true);
    expect(() => addon.validateSnapshot(frame)).toThrow();
  });

  it('validateSnapshot throws for too-short buffer', () => {
    expect(() => addon.validateSnapshot(new Uint8Array(4))).toThrow();
  });

  it('validateSnapshot throws for non-JSON payload', () => {
    const frame = makeAximFrame('not json');
    expect(() => addon.validateSnapshot(frame)).toThrow();
  });

  // --- computeStateHash ---

  it('computeStateHash returns 0 and writes non-zero hash', () => {
    const input = makeAximFrame('{"state":"test"}');
    const output = new Uint8Array(40);
    expect(addon.computeStateHash(input, output)).toBe(0);
    expect(output.some((b: number) => b !== 0)).toBe(true);
  });

  it('computeStateHash is deterministic', () => {
    const input = makeAximFrame('{"state":"test"}');
    const out1 = new Uint8Array(40);
    const out2 = new Uint8Array(40);
    addon.computeStateHash(input, out1);
    addon.computeStateHash(input, out2);
    expect(Buffer.from(out1)).toEqual(Buffer.from(out2));
  });

  it('computeStateHash produces different hashes for different payloads', () => {
    const out1 = new Uint8Array(40);
    const out2 = new Uint8Array(40);
    addon.computeStateHash(makeAximFrame('{"a":1}'), out1);
    addon.computeStateHash(makeAximFrame('{"b":2}'), out2);
    expect(Buffer.from(out1)).not.toEqual(Buffer.from(out2));
  });

  it('computeStateHash throws when output buffer is too small', () => {
    const input = makeAximFrame('{"x":1}');
    const tiny = new Uint8Array(4);
    expect(() => addon.computeStateHash(input, tiny)).toThrow();
  });

  // --- applyEvents ---

  it('applyEvents returns bytes written for valid snapshot+events', () => {
    const snap = makeAximFrame('{"state":"v1"}');
    const events = makeAximFrame('[]');
    const output = new Uint8Array(256);
    const written = addon.applyEvents(snap, events, output);
    expect(written).toBeGreaterThan(0);
  });

  it('applyEvents output is valid AXIM frame', () => {
    const snap = makeAximFrame('{"state":"v1"}');
    const events = makeAximFrame('[]');
    const output = new Uint8Array(256);
    const written = addon.applyEvents(snap, events, output);
    const dv = new DataView(output.buffer);
    expect(dv.getUint32(0, true)).toBe(AXIM_MAGIC);
    expect(dv.getInt32(4, true)).toBe(written);
  });

  it('applyEvents throws for invalid snapshot magic', () => {
    const badSnap = makeAximFrame('{"state":"v1"}');
    new DataView(badSnap.buffer).setUint32(0, 0xdeadbeef, true);
    const events = makeAximFrame('[]');
    const output = new Uint8Array(256);
    expect(() => addon.applyEvents(badSnap, events, output)).toThrow();
  });

  // --- migrateSnapshot ---

  it('migrateSnapshot v1→v1 returns bytes written', () => {
    const data = makeAximFrame('{"v":1}');
    const output = new Uint8Array(256);
    const written = addon.migrateSnapshot(data, 1, 1, output);
    expect(written).toBeGreaterThan(0);
  });

  it('migrateSnapshot v1→v3 returns bytes written', () => {
    const data = makeAximFrame('{"v":1}');
    const output = new Uint8Array(256);
    const written = addon.migrateSnapshot(data, 1, 3, output);
    expect(written).toBeGreaterThan(0);
  });

  it('migrateSnapshot throws for invalid version (from > to)', () => {
    const data = makeAximFrame('{"v":1}');
    const output = new Uint8Array(256);
    expect(() => addon.migrateSnapshot(data, 2, 1, output)).toThrow();
  });

  it('migrateSnapshot throws for zero version', () => {
    const data = makeAximFrame('{"v":1}');
    const output = new Uint8Array(256);
    expect(() => addon.migrateSnapshot(data, 0, 1, output)).toThrow();
  });

  it('migrateSnapshot output preserves payload content', () => {
    const payload = '{"key":"migrated"}';
    const data = makeAximFrame(payload);
    const output = new Uint8Array(256);
    const written = addon.migrateSnapshot(data, 1, 2, output);
    const outputPayload = new TextDecoder().decode(output.slice(8, written));
    expect(outputPayload).toBe(payload);
  });
});
