import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { KEEP_LAST_EPOCHS } from '#/agent/snapshot/types';
import type { AgentSnapshot } from '#/agent/snapshot/types';

export class SnapshotPersistence {
  private readonly snapshotDir: string;

  constructor(private readonly sessionDir: string) {
    this.snapshotDir = join(sessionDir, 'snapshots');
  }

  getSnapshotDir(): string {
    return this.snapshotDir;
  }

  /** Save a snapshot to disk as snapshot.epoch.{epoch}.json. */
  async save(snapshot: AgentSnapshot): Promise<void> {
    await mkdir(this.snapshotDir, { recursive: true });
    const filePath = this.filePath(snapshot.header.epoch);
    await writeFile(filePath, JSON.stringify(snapshot), 'utf-8');
  }

  /** Load the snapshot with the highest epoch number, or null if none exist. */
  async loadLatest(): Promise<AgentSnapshot | null> {
    const epochs = await this.listEpochs();
    if (epochs.length === 0) return null;

    const latestEpoch = epochs[epochs.length - 1]!;
    const filePath = this.filePath(latestEpoch);
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as AgentSnapshot;
  }

  /** List all persisted epoch numbers, sorted ascending. */
  async listEpochs(): Promise<number[]> {
    await mkdir(this.snapshotDir, { recursive: true });
    const entries = await readdir(this.snapshotDir);

    const epochs: number[] = [];
    for (const entry of entries) {
      const match = /^snapshot\.epoch\.(\d+)\.json$/.exec(entry);
      if (match?.[1] != null) {
        epochs.push(Number(match[1]));
      }
    }

    return epochs.sort((a, b) => a - b);
  }

  /** Delete old snapshots, keeping only the last `keepLast` epochs. */
  async prune(keepLast: number = KEEP_LAST_EPOCHS): Promise<void> {
    const epochs = await this.listEpochs();
    if (epochs.length <= keepLast) return;

    const toDelete = epochs.slice(0, epochs.length - keepLast);
    for (const epoch of toDelete) {
      await rm(this.filePath(epoch), { force: true });
    }
  }

  private filePath(epoch: number): string {
    return join(this.snapshotDir, `snapshot.epoch.${epoch}.json`);
  }
}
