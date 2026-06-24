import type { TUI } from '@earendil-works/pi-tui';

/**
 * Render transaction — suppresses intermediate requestRender() calls during
 * a batch of tree mutations (clear + addChild, state updates, etc.) and
 * flushes a single differential render at commit time.
 *
 * This prevents the "empty frame" glitch that occurs when a timer-driven
 * render fires between Container.clear() and addChild().
 *
 * Usage:
 *   const tx = new RenderTransaction(ui);
 *   tx.begin();
 *   try {
 *     // ... tree mutations ...
 *   } finally {
 *     tx.commit();
 *   }
 */
export class RenderTransaction {
  private ui: TUI;
  private savedRequestRender: TUI['requestRender'] | null = null;
  private pending = false;

  constructor(ui: TUI) {
    this.ui = ui;
  }

  /** Suppress all requestRender calls until commit(). */
  begin(): void {
    this.pending = false;
    // Capture the current requestRender at begin() time — not constructor time.
    // This preserves test mocks (vi.spyOn) that are set up after construction.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: we need the raw function reference to preserve mock identity
    this.savedRequestRender = this.ui.requestRender;
    this.ui.requestRender = () => {
      this.pending = true;
    };
  }

  /** Restore requestRender and flush a single differential render if needed. */
  commit(): void {
    if (this.savedRequestRender) {
      this.ui.requestRender = this.savedRequestRender;
    }
    if (this.pending) {
      this.pending = false;
      // Use differential render (not force) — pi-tui's line-by-line diff
      // will only repaint changed lines. Force render is reserved for
      // resize events where the viewport state machine needs a full reset.
      this.savedRequestRender?.call(this.ui);
    }
  }
}
