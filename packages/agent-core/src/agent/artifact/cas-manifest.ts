/**
 * CAS Manifest — Content-Addressable Storage manifest for deterministic artifact management.
 *
 * Guarantees:
 * - Deterministic serialization: sorted keys, sorted file paths
 * - Content addressing: SHA-256 hash per file blob
 * - Immutable: once created, commit_id never changes for same content
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// ── Schema ────────────────────────────────────────────────────────────────

export const CASManifestEntrySchema = z.object({
  path: z.string().min(1),
  hash: z.string().length(64),
  mode: z.number().int().optional().default(0o644),
});

export const CASManifestSchema = z.object({
  commit_id: z.string().length(64),
  created_at: z.number().int().positive(),
  manifest: z.array(CASManifestEntrySchema),
  blobs: z.record(z.string(), z.string()),
});

export type CASManifestEntry = z.infer<typeof CASManifestEntrySchema>;
export type CASManifest = z.infer<typeof CASManifestSchema>;

// ── Deterministic Serialization ───────────────────────────────────────────

/**
 * Deterministic JSON serialization with sorted keys.
 *
 * Unlike `JSON.stringify`, this function guarantees identical output
 * regardless of object key insertion order. This is critical for CAS:
 * "same content = same ID" must hold across all runtime contexts.
 */
function deterministicStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(deterministicStringify).join(',')}]`;

  const sortedKeys = Object.keys(obj).toSorted();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${deterministicStringify((obj as Record<string, unknown>)[key])}`,
  );
  return `{${pairs.join(',')}}`;
}

// ── CAS Manifest Creation ─────────────────────────────────────────────────

export interface FileInput {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

/**
 * Create a CAS manifest from file inputs.
 *
 * The commit_id is a deterministic SHA-256 hash of the sorted manifest and blobs.
 * Given identical file contents and paths, this function always produces the same commit_id
 * regardless of input order or runtime context.
 */
export function createCASManifest(files: readonly FileInput[]): CASManifest {
  const blobs: Record<string, string> = {};

  // Sort by path for deterministic ordering
  const sortedFiles = [...files].toSorted((a, b) => a.path.localeCompare(b.path));

  const manifest: CASManifestEntry[] = sortedFiles.map((file) => {
    const hash = createHash('sha256').update(file.content).digest('hex');
    blobs[hash] = file.content;
    return { path: file.path, hash, mode: file.mode ?? 0o644 };
  });

  // Deterministic commit_id from sorted structure
  const commitId = createHash('sha256')
    .update(deterministicStringify({ manifest, blobs }))
    .digest('hex');

  return {
    commit_id: commitId,
    created_at: Date.now(),
    manifest,
    blobs,
  };
}

// ── Verification ──────────────────────────────────────────────────────────

/**
 * Verify all blob hashes in a CAS manifest.
 * Returns an array of error messages; empty array means all valid.
 */
export function verifyCASManifest(cas: CASManifest): string[] {
  const errors: string[] = [];

  for (const entry of cas.manifest) {
    const content = cas.blobs[entry.hash];
    if (content === undefined) {
      errors.push(`Missing blob for hash ${entry.hash} (path: ${entry.path})`);
      continue;
    }

    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== entry.hash) {
      errors.push(
        `Hash mismatch for ${entry.path}: expected ${entry.hash}, got ${actualHash}`,
      );
    }
  }

  // Verify commit_id
  const expectedCommitId = createHash('sha256')
    .update(deterministicStringify({ manifest: cas.manifest, blobs: cas.blobs }))
    .digest('hex');

  if (cas.commit_id !== expectedCommitId) {
    errors.push(
      `Commit ID mismatch: expected ${expectedCommitId}, got ${cas.commit_id}`,
    );
  }

  return errors;
}
