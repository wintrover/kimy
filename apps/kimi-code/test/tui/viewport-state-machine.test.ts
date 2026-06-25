import { describe, expect, it, beforeEach } from 'vitest';

import { createHeadlessTUI, createMockComponent } from './helpers/viewport-test-harness';

/**
 * Headless tests for the viewport state machine in the pi-tui patch.
 *
 * These tests verify deterministic scroll-preservation behavior by:
 * 1. Creating a TUI instance with a fake terminal (no real I/O)
 * 2. Injecting internal state via `(tui as any)` (JS has no runtime private)
 * 3. Calling `(tui as any).doRender()` synchronously (bypasses nextTick/setTimeout)
 * 4. Asserting `previousViewportTop` after each render
 *
 * The `wasAtBottom` check distinguishes "intentionally scrolled up" from
 * "content grew, pushing viewport above new bottom".
 */

const ROWS = 10;
const COLS = 120;

function makeLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i}`);
}

describe('Viewport State Machine', () => {
  let tui: any;
  let terminal: ReturnType<typeof createHeadlessTUI>['terminal'];
  let mockComponent: ReturnType<typeof createMockComponent>;

  beforeEach(() => {
    ({ tui, terminal } = createHeadlessTUI(ROWS, COLS));
    mockComponent = createMockComponent(makeLines(100));
    tui.addChild(mockComponent);
  });

  /**
   * Helper: run one full render cycle to populate previousLines/previousViewportTop.
   * After this, the viewport is at the bottom (line 90 with 100 lines, height 10).
   */
  function initialRender(lineCount: number): void {
    mockComponent.setLines(makeLines(lineCount));
    tui.doRender();
  }

  // ─── SC-01: At bottom, content grows → viewport follows to new bottom ───

  it('SC-01: viewport follows to bottom when user is at bottom and content grows', () => {
    initialRender(100);
    expect(tui.previousViewportTop).toBe(90); // max(0, 100 - 10)

    // Add one line — user was at bottom
    mockComponent.setLines(makeLines(101));
    tui.doRender();

    // Viewport should follow to new bottom
    expect(tui.previousViewportTop).toBe(91); // max(0, 101 - 10)
  });

  // ─── SC-02: Scrolled up, content grows → viewport stays ───

  it('SC-02: viewport stays when user is scrolled up and content grows', () => {
    initialRender(100);
    expect(tui.previousViewportTop).toBe(90);

    // Simulate user scrolling up to line 50
    tui.previousViewportTop = 50;

    // Add one line
    mockComponent.setLines(makeLines(101));
    tui.doRender();

    // Viewport should stay at 50 (user intentionally scrolled up)
    expect(tui.previousViewportTop).toBe(50);
  });

  // ─── SC-03: Content shrinks below viewport → defensive guard clamps ───

  it('SC-03: viewport clamps when content shrinks below viewport', () => {
    initialRender(100);
    expect(tui.previousViewportTop).toBe(90);

    // Shrink content to 50 lines — viewport top 90 is now past maxViewportTop (40)
    mockComponent.setLines(makeLines(50));
    tui.doRender();

    // Defensive guard should clamp: maxViewportTop = max(0, 50 - 10) = 40
    expect(tui.previousViewportTop).toBeLessThanOrEqual(40);
  });

  // ─── SC-04: Force render resets viewport to bottom ───

  it('SC-04: force render resets viewport to bottom', () => {
    initialRender(100);
    expect(tui.previousViewportTop).toBe(90);

    // Simulate user scrolling up
    tui.previousViewportTop = 50;

    // Simulate what requestRender(true) does — reset state, then render
    tui.previousLines = [];
    tui.previousWidth = -1;
    tui.previousHeight = -1;
    tui.cursorRow = 0;
    tui.hardwareCursorRow = 0;
    tui.maxLinesRendered = 0;
    tui.previousViewportTop = 0;

    mockComponent.setLines(makeLines(101));
    tui.doRender();

    // Viewport should be at the new bottom
    expect(tui.previousViewportTop).toBe(91); // max(0, 101 - 10)
  });

  // ─── SC-05: Changes above viewport when scrolled up → skip rendering ───

  it('SC-05: changes above viewport are skipped when user is scrolled up', () => {
    initialRender(100);
    expect(tui.previousViewportTop).toBe(90);

    // Simulate user scrolling up to line 50
    tui.previousViewportTop = 50;

    // Modify only line 5 (above viewport 50-59)
    const lines = makeLines(100);
    lines[5] = 'modified line 5';
    mockComponent.setLines(lines);

    const writeCountBefore = terminal.written.length;
    tui.doRender();

    // Viewport should stay at 50
    expect(tui.previousViewportTop).toBe(50);

    // The modified line is above the viewport — rendering should be skipped
    // (no terminal.write calls for the content change)
    expect(terminal.written.length).toBe(writeCountBefore);
  });
});
