import { getDiagnostics } from '#/tui/render-diagnostics';
import type { SlashCommandHost } from './dispatch';

export function handleRenderLogCommand(host: SlashCommandHost): void {
  const diagnostics = getDiagnostics();
  if (diagnostics.totalRecorded === 0) {
    host.showNotice('No render events recorded yet');
    return;
  }
  try {
    const filePath = diagnostics.dumpToFile();
    host.showNotice('Render log saved', filePath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    host.showError(`Failed to dump render log: ${msg}`);
  }
}
