import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('#/tui/render-diagnostics', () => ({
  getDiagnostics: vi.fn(),
}));

import { getDiagnostics } from '#/tui/render-diagnostics';
import { handleRenderLogCommand } from '#/tui/commands/render-log';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(): SlashCommandHost {
  return {
    showError: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost;
}

describe('handleRenderLogCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows notice when no events recorded', () => {
    vi.mocked(getDiagnostics).mockReturnValue({
      totalRecorded: 0,
    } as ReturnType<typeof getDiagnostics>);
    const host = makeHost();

    handleRenderLogCommand(host);

    expect(host.showNotice).toHaveBeenCalledWith('No render events recorded yet');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('shows path on successful dump', () => {
    vi.mocked(getDiagnostics).mockReturnValue({
      totalRecorded: 5,
      dumpToFile: vi.fn().mockReturnValue('/tmp/test.jsonl'),
    } as ReturnType<typeof getDiagnostics>);
    const host = makeHost();

    handleRenderLogCommand(host);

    expect(host.showNotice).toHaveBeenCalledWith(
      'Render log saved',
      '/tmp/test.jsonl',
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('shows error when dumpToFile throws', () => {
    vi.mocked(getDiagnostics).mockReturnValue({
      totalRecorded: 5,
      dumpToFile: vi.fn().mockImplementation(() => {
        throw new Error('disk full');
      }),
    } as ReturnType<typeof getDiagnostics>);
    const host = makeHost();

    handleRenderLogCommand(host);

    expect(host.showError).toHaveBeenCalledWith(
      'Failed to dump render log: disk full',
    );
    expect(host.showNotice).not.toHaveBeenCalled();
  });
});
