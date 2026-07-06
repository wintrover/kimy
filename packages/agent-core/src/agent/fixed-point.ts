/**
 * Fixed-point arithmetic utilities for deterministic core calculations.
 * All ratio calculations use integer math to avoid IEEE 754 NaN/rounding issues.
 *
 * Scale: 400 = 1.0 (0.25% resolution, sufficient for 0-100% range)
 */

/** Fixed-point scale factor: 1.0 = FP_SCALE */
export const FP_SCALE = 400

/**
 * Convert a ratio to fixed-point integer.
 * @param numerator - The numerator (e.g., tokens used)
 * @param denominator - The denominator (e.g., max tokens)
 * @returns Integer in [0, FP_SCALE] representing the ratio
 */
export function toFixedPoint(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return (numerator * FP_SCALE) / denominator | 0
}

/**
 * Check if fixed-point value >= threshold percentage.
 * @param fp - Fixed-point value (0-400)
 * @param thresholdPercent - Threshold as percentage (0-100)
 */
export function fpGte(fp: number, thresholdPercent: number): boolean {
  return fp >= thresholdPercent * (FP_SCALE / 100)
}

/**
 * Check if fixed-point value < threshold percentage.
 */
export function fpLt(fp: number, thresholdPercent: number): boolean {
  return fp < thresholdPercent * (FP_SCALE / 100)
}

/**
 * Integer division with rounding up (ceiling).
 * Replaces Math.ceil(a * b / c) with integer-only math.
 */
export function intCeilMulDiv(a: number, b: number, c: number): number {
  return ((a * b) + c - 1) / c | 0
}
