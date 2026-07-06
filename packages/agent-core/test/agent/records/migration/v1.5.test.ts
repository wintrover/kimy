import { describe, expect, it } from 'vitest';

import { migrateV1_4ToV1_5 } from '../../../../src/agent/records/migration/v1.5';
import { runMigration } from './utils';

describe('1.4 to 1.5', () => {
  it('passes snapshot.checkpoint records through unchanged', () => {
    expect(
      runMigration(migrateV1_4ToV1_5, [
        {
          type: 'metadata',
          protocol_version: '1.4',
          created_at: 1,
        },
        {
          type: 'snapshot.checkpoint',
          epoch: 1,
          wireRecordCount: 42,
          snapshotFile: '/tmp/snapshots/epoch-1.json',
          sha256: 'abc123',
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata              { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] snapshot.checkpoint   { "epoch": 1, "wireRecordCount": 42, "snapshotFile": "/tmp/snapshots/epoch-1.json", "sha256": "abc123" }
    `);
  });

  it('passes existing record types through unchanged', () => {
    expect(
      runMigration(migrateV1_4ToV1_5, [
        {
          type: 'metadata',
          protocol_version: '1.4',
          created_at: 1,
        },
        {
          type: 'goal.create',
          goalId: 'goal-1',
          objective: 'ship the feature',
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata      { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] goal.create   { "goalId": "goal-1", "objective": "ship the feature" }
    `);
  });
});
