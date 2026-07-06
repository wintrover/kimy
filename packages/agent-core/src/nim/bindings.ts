/**
 * NapiAgentCore — TypeScript binding for the Nim native addon.
 * Uses StaticRingBuffer for GC zero-allocation data passing.
 */

import { createRequire } from 'node:module';
import type { RawNimAddon } from './types.js';
import { StaticRingBuffer } from './ring-buffer.js';

let addon: RawNimAddon | null = null;

function getAddon(): RawNimAddon {
  if (!addon) {
    try {
      const require = createRequire(import.meta.url);
      addon = require('../../native/node/build/Release/nim_agent_core.node') as RawNimAddon;
    } catch {
      throw new Error(
        'Failed to load nim_agent_core native addon. ' +
          "Run 'cd native && ./build.sh' first.",
      );
    }
  }
  return addon;
}

export class NapiAgentCore {
  private readonly ring: StaticRingBuffer;

  constructor(bufferSize: number = 65536) {
    this.ring = new StaticRingBuffer(bufferSize);
  }

  /** Score a move from pre-serialized binary data. Returns >= 0 on success. */
  scoreMove(payload: Uint8Array): number {
    this.ring.reset();
    const ref = this.ring.writeFrame(payload);
    const frame = this.ring.getFrameView(ref.offset, ref.length);
    return getAddon().scoreMove(frame);
  }

  /** Evaluate heuristic from pre-serialized binary data. Returns >= 0 on success. */
  evaluateHeuristic(payload: Uint8Array): number {
    this.ring.reset();
    const ref = this.ring.writeFrame(payload);
    const frame = this.ring.getFrameView(ref.offset, ref.length);
    return getAddon().evaluateHeuristic(frame);
  }

  /** Check invariant from pre-serialized binary data. Returns 0 if invariant holds. */
  checkInvariant(payload: Uint8Array): number {
    this.ring.reset();
    const ref = this.ring.writeFrame(payload);
    const frame = this.ring.getFrameView(ref.offset, ref.length);
    return getAddon().checkInvariant(frame);
  }

  /** Trace consequences from pre-serialized binary data. Returns count >= 0. */
  traceConsequences(payload: Uint8Array): number {
    this.ring.reset();
    const ref = this.ring.writeFrame(payload);
    const frame = this.ring.getFrameView(ref.offset, ref.length);
    return getAddon().traceConsequences(frame);
  }

  /** Compute a deterministic 40-byte hash over an AXIM frame payload. */
  computeStateHash(input: Uint8Array, output: Uint8Array): number {
    this.ring.reset();
    const ref = this.ring.writeFrame(input);
    const frame = this.ring.getFrameView(ref.offset, ref.length);
    return getAddon().computeStateHash(frame, output);
  }

  /** Validate a snapshot buffer (AXIM header + JSON braces). Returns 0 if valid. */
  validateSnapshot(data: Uint8Array): number {
    this.ring.reset();
    const ref = this.ring.writeFrame(data);
    const frame = this.ring.getFrameView(ref.offset, ref.length);
    return getAddon().validateSnapshot(frame);
  }

  /** Apply event delta to a snapshot. Returns bytes written. */
  applyEvents(snapshot: Uint8Array, events: Uint8Array, output: Uint8Array): number {
    return getAddon().applyEvents(snapshot, events, output);
  }

  /** Migrate a snapshot from one version to another. Returns bytes written. */
  migrateSnapshot(data: Uint8Array, fromVersion: number, toVersion: number, output: Uint8Array): number {
    return getAddon().migrateSnapshot(data, fromVersion, toVersion, output);
  }

  /** Get the underlying ring buffer (for testing). */
  getRingBuffer(): StaticRingBuffer {
    return this.ring;
  }
}
