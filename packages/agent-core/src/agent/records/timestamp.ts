/**
 * Returns a deterministic timestamp during replay (wire record's original time),
 * or wall-clock time during live execution.
 *
 * Physical wall-clock time belongs only in the Shell layer.
 * During replay, we use the record's original timestamp for determinism.
 */
export function getTimestamp(restoring: { time?: number } | null): number {
  return restoring?.time ?? Date.now();
}
