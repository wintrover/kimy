import { EPOCH_SIZE } from '#/agent/snapshot/types';

/** Compute which epoch a turnCount belongs to. */
export function computeEpoch(turnCount: number): number {
  return Math.floor(turnCount / EPOCH_SIZE);
}

/** Whether a snapshot should be created at this turnCount (every EPOCH_SIZE turns). */
export function shouldCreateSnapshot(turnCount: number): boolean {
  return turnCount > 0 && turnCount % EPOCH_SIZE === 0;
}
