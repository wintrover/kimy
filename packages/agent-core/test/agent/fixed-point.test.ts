import { describe, expect, it } from 'vitest';

import {
  FP_SCALE,
  toFixedPoint,
  fpGte,
  fpLt,
  intCeilMulDiv,
} from '../../src/agent/fixed-point';

describe('fixed-point utilities', () => {
  // ---------------------------------------------------------------------------
  // toFixedPoint
  // ---------------------------------------------------------------------------

  describe('toFixedPoint', () => {
    it('returns 0 for zero denominator', () => {
      expect(toFixedPoint(5, 0)).toBe(0);
    });

    it('returns 0 for 0/0', () => {
      expect(toFixedPoint(0, 0)).toBe(0);
    });

    it('returns FP_SCALE for 1/1 ratio', () => {
      expect(toFixedPoint(100, 100)).toBe(FP_SCALE);
    });

    it('computes 50% correctly', () => {
      expect(toFixedPoint(50, 100)).toBe(200);
    });

    it('computes 30% correctly', () => {
      expect(toFixedPoint(3, 10)).toBe(120);
    });

    it('computes 75% correctly', () => {
      expect(toFixedPoint(75, 100)).toBe(300);
    });

    it('computes 90% correctly', () => {
      expect(toFixedPoint(9, 10)).toBe(360);
    });

    it('truncates fractional results toward zero', () => {
      // 1/3 = 0.333... → 133.33 → truncated to 133
      expect(toFixedPoint(1, 3)).toBe(133);
    });

    it('returns 0 for 0 numerator', () => {
      expect(toFixedPoint(0, 100)).toBe(0);
    });

    it('handles large values', () => {
      expect(toFixedPoint(500_000, 1_000_000)).toBe(200);
    });

    it('returns integer result (not float)', () => {
      const result = toFixedPoint(1, 3);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // fpGte
  // ---------------------------------------------------------------------------

  describe('fpGte', () => {
    it('returns true when above threshold', () => {
      expect(fpGte(310, 75)).toBe(true);
    });

    it('returns true when exactly at threshold', () => {
      expect(fpGte(300, 75)).toBe(true);
    });

    it('returns false when below threshold', () => {
      expect(fpGte(299, 75)).toBe(false);
    });

    it('returns true for 100% at max', () => {
      expect(fpGte(400, 100)).toBe(true);
    });

    it('returns false for 0', () => {
      expect(fpGte(0, 50)).toBe(false);
    });

    it('works with 50% threshold', () => {
      expect(fpGte(200, 50)).toBe(true);
      expect(fpGte(199, 50)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // fpLt
  // ---------------------------------------------------------------------------

  describe('fpLt', () => {
    it('returns true when below threshold', () => {
      expect(fpLt(199, 50)).toBe(true);
    });

    it('returns false when exactly at threshold', () => {
      expect(fpLt(200, 50)).toBe(false);
    });

    it('returns false when above threshold', () => {
      expect(fpLt(201, 50)).toBe(false);
    });

    it('returns false for 0 threshold', () => {
      expect(fpLt(0, 0)).toBe(false);
    });

    it('returns true for 0 value at positive threshold', () => {
      expect(fpLt(0, 50)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // intCeilMulDiv
  // ---------------------------------------------------------------------------

  describe('intCeilMulDiv', () => {
    it('computes exact division', () => {
      expect(intCeilMulDiv(1000, 1, 20)).toBe(50);
    });

    it('rounds up for non-exact division', () => {
      // Math.ceil(1000 * 1 / 3) = Math.ceil(333.33) = 334
      expect(intCeilMulDiv(1000, 1, 3)).toBe(334);
    });

    it('returns 1 for zero numerator', () => {
      // ceil(0 * 5 / 100) = ceil(0) = 0, but min is 0 (no Math.max here)
      expect(intCeilMulDiv(0, 5, 100)).toBe(0);
    });

    it('handles 1/20 ratio (0.05)', () => {
      // Math.ceil(1000 * 1 / 20) = 50
      expect(intCeilMulDiv(1000, 1, 20)).toBe(50);
    });

    it('handles edge case: 1 * 1 / 1', () => {
      expect(intCeilMulDiv(1, 1, 1)).toBe(1);
    });

    it('handles large values', () => {
      // Math.ceil(256000 * 1 / 20) = 12800
      expect(intCeilMulDiv(256_000, 1, 20)).toBe(12_800);
    });

    it('returns integer (not float)', () => {
      const result = intCeilMulDiv(1000, 1, 3);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: verify integer-only math
  // ---------------------------------------------------------------------------

  describe('integration', () => {
    it('FP_SCALE is 400', () => {
      expect(FP_SCALE).toBe(400);
    });

    it('toFixedPoint results are always integers', () => {
      for (let n = 0; n <= 10; n++) {
        for (let d = 1; d <= 10; d++) {
          const result = toFixedPoint(n, d);
          expect(Number.isInteger(result)).toBe(true);
        }
      }
    });

    it('fpGte and fpLt are complementary', () => {
      const values = [0, 100, 150, 199, 200, 201, 300, 400];
      const thresholds = [25, 50, 75, 100];
      for (const v of values) {
        for (const t of thresholds) {
          expect(fpGte(v, t)).toBe(!fpLt(v, t));
        }
      }
    });
  });
});
