import { describe, expect, it, vi } from 'vitest';
import { RenderTransaction } from '#/tui/render-transaction';

function createMockUI() {
  return {
    requestRender: vi.fn(),
  } as unknown as import('@earendil-works/pi-tui').TUI;
}

describe('RenderTransaction', () => {
  it('suppresses requestRender during transaction and flushes at commit', () => {
    const ui = createMockUI();
    const originalSpy = ui.requestRender;
    const tx = new RenderTransaction(ui);

    tx.begin();

    // requestRender is replaced — calling it sets pending flag, original spy is not called
    (ui as unknown as { requestRender: () => void }).requestRender();
    expect(originalSpy).not.toHaveBeenCalled();

    tx.commit();
    expect(originalSpy).toHaveBeenCalledOnce();
  });

  it('does not flush if nothing triggered requestRender during transaction', () => {
    const ui = createMockUI();
    const tx = new RenderTransaction(ui);

    tx.begin();
    tx.commit();

    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it('restores original requestRender after commit', () => {
    const ui = createMockUI();
    const original = ui.requestRender;
    const tx = new RenderTransaction(ui);

    tx.begin();
    expect(ui.requestRender).not.toBe(original);

    tx.commit();
    expect(ui.requestRender).toBe(original);
  });

  it('multiple requestRender calls during transaction only flush once', () => {
    const ui = createMockUI();
    const tx = new RenderTransaction(ui);

    tx.begin();
    (ui as unknown as { requestRender: () => void }).requestRender();
    (ui as unknown as { requestRender: () => void }).requestRender();
    (ui as unknown as { requestRender: () => void }).requestRender();

    tx.commit();
    expect(ui.requestRender).toHaveBeenCalledOnce();
  });
});
