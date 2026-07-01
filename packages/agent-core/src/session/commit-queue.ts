/**
 * CommitQueue — mutex + queue for serializing git cherry-pick operations.
 *
 * When multiple agents finish their work concurrently, their commits must be
 * serialized to avoid race conditions on the git index. The CommitQueue wraps a
 * Mutex so each commit runs exclusively.
 */

export class Mutex {
  private _locked = false;
  private readonly _waitQueue: Array<() => void> = [];

  get locked(): boolean {
    return this._locked;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._waitQueue.push(resolve);
    });
  }

  private release(): void {
    const next = this._waitQueue.shift();
    if (next !== undefined) {
      next();
    } else {
      this._locked = false;
    }
  }
}

export class CommitQueue {
  private readonly mutex = new Mutex();

  get pending(): number {
    return this.mutex.locked ? 1 : 0;
  }

  async enqueue<T>(commit: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(commit);
  }
}
