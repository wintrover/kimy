import type { TUI } from '@earendil-works/pi-tui';

import type { RenderDiagnostics } from '#/tui/render-diagnostics';
import { captureCaller, isEnabled } from '#/tui/render-diagnostics';

/**
 * Render transaction — suppresses intermediate requestRender() calls during
 * a batch of tree mutations (clear + addChild, state updates, etc.) and
 * flushes a single differential render at commit time.
 *
 * Supports nested transactions: inner begin/commit pairs are no-ops for
 * the monkey-patch and render logic — only the outermost commit restores
 * requestRender and flushes.
 *
 * ⚠️ SYNC ONLY: Because this monkey-patches ui.requestRender, the
 * begin/commit boundary must not contain async yields (await).
 * An async yield would allow unrelated event handlers to call the
 * suppressed requestRender, corrupting the pending flag.
 *
 * Usage:
 *   const tx = new RenderTransaction(ui);
 *   tx.begin();
 *   try {
 *     // ... synchronous tree mutations ...
 *     // Inner tx.begin()/commit() calls are safe — they nest correctly.
 *   } finally {
 *     tx.commit();
 *   }
 */
export class RenderTransaction {
  private ui: TUI;
  private savedRequestRender: TUI['requestRender'] | null = null;
  private pending = false;
  private depth = 0;
  private suppressedCount = 0;
  private readonly diagnostics: RenderDiagnostics | null;

  constructor(ui: TUI, diagnostics?: RenderDiagnostics) {
    this.ui = ui;
    this.diagnostics = diagnostics ?? null;
  }

  /** Current nesting depth. 0 means no active transaction. */
  getDepth(): number {
    return this.depth;
  }

  /**
   * Suppress all requestRender calls until the matching outermost commit().
   * Safe to call nested — only the first call monkey-patches.
   */
  begin(): void {
    if (this.depth === 0) {
      this.pending = false;
      this.suppressedCount = 0;
      // Capture the current requestRender at begin() time — not constructor time.
      // This preserves test mocks (vi.spyOn) that are set up after construction.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: we need the raw function reference to preserve mock identity
      this.savedRequestRender = this.ui.requestRender;
      this.ui.requestRender = (force?: boolean) => {
        this.pending = true;
        this.suppressedCount++;
        if (isEnabled() && this.diagnostics) {
          this.diagnostics.record({
            type: 'suppress',
            caller: captureCaller(),
            force: force ?? false,
            depth: this.depth,
            suppressedCount: this.suppressedCount,
          });
        }
      };
    }
    this.depth++;
  }

  /**
   * Decrement nesting depth. When the outermost transaction commits,
   * restore requestRender and flush a single render if anything was pending.
   */
  commit(): void {
    if (this.depth === 0) return; // Underflow guard — no-op if unbalanced
    this.depth--;
    if (this.depth === 0) {
      // Outermost commit — restore and flush
      if (this.savedRequestRender) {
        this.ui.requestRender = this.savedRequestRender;
      }
      if (this.pending) {
        if (isEnabled() && this.diagnostics) {
          this.diagnostics.record({
            type: 'commit',
            caller: captureCaller(),
            force: false,
            depth: 0,
            suppressedCount: this.suppressedCount,
          });
        }
        this.pending = false;
        // Use differential render (not force) — pi-tui's line-by-line diff
        // will only repaint changed lines. Force render is reserved for
        // resize events where the viewport state machine needs a full reset.
        this.savedRequestRender?.call(this.ui);
      }
    }
  }
}
