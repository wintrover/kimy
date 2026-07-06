import type { WireMigration, WireMigrationRecord } from './index';

export const migrateV1_4ToV1_5: WireMigration = {
  sourceVersion: '1.4',
  targetVersion: '1.5',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    // snapshot.checkpoint is a new informational record type introduced in 1.5.
    // Older sessions will not contain this record, but if one is encountered it
    // passes through unchanged.
    return record;
  },
};
