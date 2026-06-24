import { describe, expect, it } from 'vitest';

/**
 * Pure-function extraction of the viewport state machine from the pi-tui patch.
 *
 * This function mirrors the logic added in the differential-render patch:
 *   const maxViewportTop = Math.max(0, newLines.length - height);
 *   if (prevViewportTop > maxViewportTop) prevViewportTop = maxViewportTop;
 *   const wasAtBottom = this.previousLines.length === 0 ||
 *       this.previousViewportTop >= Math.max(0, this.previousLines.length - height);
 *   const isUserScrolledUp = this.previousLines.length > 0
 *       && prevViewportTop < maxViewportTop && !wasAtBottom;
 *
 * By extracting it into a pure function we can unit-test every branch
 * without needing a headless TUI or a real terminal.
 */
function deriveViewportState(opts: {
  previousLinesLength: number;
  previousViewportTop: number;
  newLinesLength: number;
  height: number;
}): {
  wasAtBottom: boolean;
  isUserScrolledUp: boolean;
  maxViewportTop: number;
  clampedViewportTop: number;
} {
  const { previousLinesLength, newLinesLength, height } = opts;

  const maxViewportTop = Math.max(0, newLinesLength - height);

  // Defensive guard: clamp prevViewportTop to prevent edge-case drift
  let prevViewportTop = opts.previousViewportTop;
  if (prevViewportTop > maxViewportTop) prevViewportTop = maxViewportTop;

  // Was the user at (or past) the bottom in the previous render?
  // Uses the original (pre-clamp) value — matches this.previousViewportTop in the patch.
  const wasAtBottom =
    previousLinesLength === 0 ||
    opts.previousViewportTop >= Math.max(0, previousLinesLength - height);

  // Distinguish "intentionally scrolled up" from "content grew, pushing viewport above new bottom"
  const isUserScrolledUp =
    previousLinesLength > 0 && prevViewportTop < maxViewportTop && !wasAtBottom;

  return {
    wasAtBottom,
    isUserScrolledUp,
    maxViewportTop,
    clampedViewportTop: prevViewportTop,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveViewportState', () => {
  // ─── SC-01: After resize (height change), wasAtBottom = true when previousLines is empty ───

  it('SC-01: wasAtBottom is true when previousLines.length === 0', () => {
    const result = deriveViewportState({
      previousLinesLength: 0,
      previousViewportTop: 0,
      newLinesLength: 50,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(40);
  });

  it('SC-01: wasAtBottom is true when at exact bottom with prior content', () => {
    // previousLines has 100 lines, height is 10, viewport top is 90 => at bottom
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: 90,
      newLinesLength: 50,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    // prevViewportTop (90) > maxViewportTop (40), so clamped to 40
    expect(result.clampedViewportTop).toBe(40);
    expect(result.isUserScrolledUp).toBe(false);
  });

  // ─── SC-02: During streaming (content growth), when user is at bottom, new content scrolls to bottom ───

  it('SC-02: at bottom + content grows → wasAtBottom, not scrolled up', () => {
    // Simulates: had 100 lines, viewport at 90 (bottom), now 105 lines
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: 90,
      newLinesLength: 105,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(95);
    // viewport stays at 90 (clampedViewportTop) — caller will advance it to 95
    expect(result.clampedViewportTop).toBe(90);
  });

  it('SC-02: at bottom with single new line appended', () => {
    const result = deriveViewportState({
      previousLinesLength: 10,
      previousViewportTop: 0,
      newLinesLength: 11,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(1);
  });

  // ─── SC-03: When user scrolls up, viewport position is preserved (isUserScrolledUp = true) ───

  it('SC-03: user scrolled up → isUserScrolledUp is true, wasAtBottom is false', () => {
    // previousLines has 100 lines, viewport top at 50 (scrolled up from bottom 90)
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: 50,
      newLinesLength: 101,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(false);
    expect(result.isUserScrolledUp).toBe(true);
    expect(result.maxViewportTop).toBe(91);
    // Viewport position is preserved — not clamped
    expect(result.clampedViewportTop).toBe(50);
  });

  it('SC-03: user scrolled up to top of file', () => {
    const result = deriveViewportState({
      previousLinesLength: 200,
      previousViewportTop: 0,
      newLinesLength: 205,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(false);
    expect(result.isUserScrolledUp).toBe(true);
    expect(result.clampedViewportTop).toBe(0);
  });

  // ─── SC-04: Force render resets all state (previousLines=[], previousWidth=-1, previousHeight=-1) ───

  it('SC-04: force render (empty previousLines) → wasAtBottom = true', () => {
    // After force render, previousLines is cleared — previousLinesLength === 0
    const result = deriveViewportState({
      previousLinesLength: 0,
      previousViewportTop: 0,
      newLinesLength: 101,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(91);
  });

  it('SC-04: force render after being scrolled up still resets to bottom', () => {
    // Simulate: user was scrolled up, then force render clears state
    const result = deriveViewportState({
      previousLinesLength: 0, // cleared by force render
      previousViewportTop: 0, // reset by force render
      newLinesLength: 101,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
  });

  // ─── SC-05: After resize with height decrease + immediate differential render, viewport is clean ───

  it('SC-05: height decrease from 20→10, was at old bottom → now viewed as scrolled up', () => {
    // Previous: 100 lines, height 20, viewport at 80 (bottom for height 20).
    // Now height shrinks to 10: new bottom is at 90, viewport at 80 is above it.
    // wasAtBottom uses the NEW height: 80 >= max(0, 100-10)=90 → false.
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: 80,
      newLinesLength: 100,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(false);
    // With the new height, viewport at 80 is above bottom (90) → treated as scrolled up
    expect(result.isUserScrolledUp).toBe(true);
    expect(result.maxViewportTop).toBe(90);
    expect(result.clampedViewportTop).toBe(80);
  });

  it('SC-05: height decrease from 20→10, scrolled up → stays scrolled up', () => {
    // Previous: 100 lines, height 20, viewport at 30 (scrolled up from bottom 80)
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: 30,
      newLinesLength: 100,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(false);
    expect(result.isUserScrolledUp).toBe(true);
    expect(result.maxViewportTop).toBe(90);
    expect(result.clampedViewportTop).toBe(30);
  });

  it('SC-05: height decrease + content shrink → defensive clamp prevents drift', () => {
    // Previous: 100 lines, height 20, viewport at 85 (bottom). Content shrinks to 30, height to 10.
    // maxViewportTop = max(0, 30 - 10) = 20. prevViewportTop 85 > 20 → clamped to 20.
    // wasAtBottom uses pre-clamp value: 85 >= max(0, 100-10)=90 → false.
    // isUserScrolledUp: 100 > 0 && 20 < 20 → false (clamped viewport equals maxViewportTop).
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: 85,
      newLinesLength: 30,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(false);
    // After clamping, viewport is at maxViewportTop → not scrolled up
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(20);
    expect(result.clampedViewportTop).toBe(20);
  });

  // ─── Edge cases ───

  it('empty content with non-zero height', () => {
    const result = deriveViewportState({
      previousLinesLength: 0,
      previousViewportTop: 0,
      newLinesLength: 0,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(0);
    expect(result.clampedViewportTop).toBe(0);
  });

  it('height equals line count → at bottom, not scrolled up', () => {
    const result = deriveViewportState({
      previousLinesLength: 10,
      previousViewportTop: 0,
      newLinesLength: 10,
      height: 10,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(0);
  });

  it('height 1 → single-line viewport', () => {
    const result = deriveViewportState({
      previousLinesLength: 50,
      previousViewportTop: 49,
      newLinesLength: 55,
      height: 1,
    });

    expect(result.wasAtBottom).toBe(true);
    expect(result.isUserScrolledUp).toBe(false);
    expect(result.maxViewportTop).toBe(54);
  });

  it('prevViewportTop negative → treated as not scrolled up (defensive)', () => {
    const result = deriveViewportState({
      previousLinesLength: 100,
      previousViewportTop: -1,
      newLinesLength: 100,
      height: 10,
    });

    // -1 < maxViewportTop(90) and previousLinesLength > 0, but wasAtBottom?
    // previousViewportTop(-1) >= max(0, 100-10)=90? No → wasAtBottom = false
    // isUserScrolledUp = 100 > 0 && -1 < 90 && !false → true
    expect(result.wasAtBottom).toBe(false);
    expect(result.isUserScrolledUp).toBe(true);
  });
});
