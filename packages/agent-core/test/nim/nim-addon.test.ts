import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NapiAgentCore } from '../../src/nim/index.js';
import { StaticRingBuffer } from '../../src/nim/ring-buffer.js';
import { AXIM_MAGIC } from '../../src/nim/types.js';

// Detect native addon — skip E2E tests if not built.
// Use createRequire for reliable detection (supports .node files natively).
const __testDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__testDir, 'package.json'));
const addonPath = '../../native/node/build/Release/nim_agent_core.node';
let nativeAvailable = false;
try {
  require(addonPath);
  nativeAvailable = true;
} catch {
  nativeAvailable = false;
}

const describeNative = nativeAvailable ? describe : describe.skip;

describe('TypeScript Bindings', () => {
  it('should export NapiAgentCore class', () => {
    expect(NapiAgentCore).toBeDefined();
    expect(typeof NapiAgentCore).toBe('function');
  });

  it('should export StaticRingBuffer class', () => {
    expect(StaticRingBuffer).toBeDefined();
    expect(typeof StaticRingBuffer).toBe('function');
  });

  it('should export AXIM_MAGIC constant', () => {
    expect(AXIM_MAGIC).toBe(0x4158494d);
  });

  it('should create NapiAgentCore instance without errors', () => {
    const core = new NapiAgentCore();
    expect(core).toBeDefined();
    expect(core.getRingBuffer()).toBeDefined();
    expect(core.getRingBuffer().capacity).toBe(65536);
  });

  it('should create NapiAgentCore with custom buffer size', () => {
    const core = new NapiAgentCore(32768);
    expect(core.getRingBuffer().capacity).toBe(32768);
  });
});

describeNative('Native Addon E2E', () => {
  it('should call scoreMove via native addon', () => {
    const core = new NapiAgentCore();
    // Create a valid frame with value 10
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, 10, true);
    const result = core.scoreMove(payload);
    expect(result).toBe(10);
  });

  it('should call evaluateHeuristic via native addon', () => {
    const core = new NapiAgentCore();
    // Create payload with two int32 values: 3 and 5
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setInt32(0, 3, true);
    view.setInt32(4, 5, true);
    // Expected: 3 * 3 + 5 = 14
    const result = core.evaluateHeuristic(payload);
    expect(result).toBe(14);
  });

  it('should call checkInvariant via native addon', () => {
    const core = new NapiAgentCore();
    // Positive value → invariant holds (returns 0)
    const positive = new Uint8Array(4);
    new DataView(positive.buffer).setInt32(0, 42, true);
    expect(core.checkInvariant(positive)).toBe(0);

    // Negative value → invariant violated (returns 1)
    const negative = new Uint8Array(4);
    new DataView(negative.buffer).setInt32(0, -1, true);
    expect(core.checkInvariant(negative)).toBe(1);
  });

  it('should call traceConsequences via native addon', () => {
    const core = new NapiAgentCore();
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, 5, true);
    const result = core.traceConsequences(payload);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should reset ring buffer across calls', () => {
    const core = new NapiAgentCore();
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, 7, true);
    const r1 = core.scoreMove(payload);
    const r2 = core.scoreMove(payload);
    expect(r1).toBe(7);
    expect(r2).toBe(7);
  });
});
