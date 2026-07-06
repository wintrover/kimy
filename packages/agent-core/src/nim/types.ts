/**
 * Types for the Nim N-API native addon.
 * All numeric results use integer-only arithmetic (no float).
 */

/** Error codes from Nim core — must match cost_pure.nim constants. */
export const enum NimErrorCode {
  ERR_BUFFER_TOO_SHORT = -1,
  ERR_MAGIC_MISMATCH = -2,
  ERR_LENGTH_OVERFLOW = -3,
  ERR_CATCHABLE = -998,
  ERR_PANIC = -999,
}

/** Magic number header constant. */
export const AXIM_MAGIC = 0x4158494d;
export const HEADER_SIZE = 8;

/** Result of a frame write to the ring buffer. */
export interface FrameRef {
  readonly offset: number;
  readonly length: number;
}

/** The raw native addon interface (from C++ N-API). */
export interface RawNimAddon {
  scoreMove(data: Uint8Array): number;
  evaluateHeuristic(data: Uint8Array): number;
  checkInvariant(data: Uint8Array): number;
  traceConsequences(data: Uint8Array): number;
  computeStateHash(input: Uint8Array, output: Uint8Array): number;
  validateSnapshot(data: Uint8Array): number;
  applyEvents(snapshot: Uint8Array, events: Uint8Array, output: Uint8Array): number;
  migrateSnapshot(data: Uint8Array, fromVersion: number, toVersion: number, output: Uint8Array): number;
}
