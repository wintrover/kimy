import { captureCaller } from '#/tui/render-diagnostics';

/** Named helper to test captureCaller from a non-internal frame. */
export function helperCaptureCaller(): string {
  return captureCaller();
}
