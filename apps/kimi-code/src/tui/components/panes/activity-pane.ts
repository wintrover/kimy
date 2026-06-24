import { Container, Spacer } from '@earendil-works/pi-tui';

import type { MoonLoader } from '../chrome/moon-loader';

export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool';

export interface ActivityPaneOptions {
  readonly mode: ActivityPaneMode;
  readonly spinner?: MoonLoader;
}

export class ActivityPaneComponent extends Container {
  private mode: ActivityPaneMode;
  private spinner?: MoonLoader;

  constructor(options: ActivityPaneOptions) {
    super();
    this.mode = options.mode;
    this.spinner = options.spinner;
    this.applyMode();
  }

  updateMode(mode: ActivityPaneMode, spinner?: MoonLoader): void {
    this.mode = mode;
    this.spinner = spinner;
    this.clear();
    this.applyMode();
    this.invalidate();
  }

  private applyMode(): void {
    if (this.mode === 'waiting' || this.mode === 'tool') {
      if (this.spinner !== undefined) {
        this.addChild(new Spacer(1));
        this.addChild(this.spinner);
      }
      return;
    }

    if (this.mode === 'composing' && this.spinner !== undefined) {
      this.addChild(new Spacer(1));
      this.addChild(this.spinner);
    }
  }
}
