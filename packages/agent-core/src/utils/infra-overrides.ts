import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '#/utils/fs';

export interface LearnedConstraints {
  [providerId: string]: { output?: number; learnedAt: string };
}

const OVERRIDES_FILE = 'infra-overrides.json';

/**
 * Load previously-learned provider constraints from disk.
 * Returns an empty object when the file does not exist or cannot be parsed.
 */
export async function loadLearnedConstraints(
  configDir: string,
): Promise<LearnedConstraints> {
  try {
    const data = await readFile(join(configDir, OVERRIDES_FILE), 'utf-8');
    return JSON.parse(data) as LearnedConstraints;
  } catch {
    return {};
  }
}

/**
 * Persist a learned output-limit for a provider.
 *
 * Uses `atomicWrite` (fsync + rename) so concurrent writers on the same
 * machine never observe a half-written file, and unique temp-file names
 * prevent cross-process collisions.
 */
export async function persistLearnedConstraint(
  configDir: string,
  providerId: string,
  outputLimit: number,
): Promise<void> {
  const existing = await loadLearnedConstraints(configDir);
  const updated: LearnedConstraints = {
    ...existing,
    [providerId]: { output: outputLimit, learnedAt: new Date().toISOString() },
  };
  await mkdir(configDir, { recursive: true });
  await atomicWrite(
    join(configDir, OVERRIDES_FILE),
    JSON.stringify(updated, null, 2),
  );
}

/**
 * In-memory runtime overrides (not persisted) for provider constraints.
 * These override static infra constraints and are populated at startup
 * from persisted learned constraints, and updated immediately when a
 * new constraint is learned mid-session.
 */
let _runtimeOverrides: Record<string, { readonly output?: number }> = {};

/**
 * Set the in-memory runtime constraint overrides.
 * Called at startup (from persisted overrides) and whenever a new
 * limit is learned (from error recovery).
 */
export function setRuntimeConstraintOverrides(
  overrides: Record<string, { readonly output?: number }>,
): void {
  _runtimeOverrides = overrides;
}

/**
 * Get the current in-memory runtime constraint overrides.
 */
export function getRuntimeConstraintOverrides(): Record<string, { readonly output?: number }> {
  return _runtimeOverrides;
}

/**
 * Merge static infra constraints with learned overrides.
 *
 * For each provider present in both maps, the tighter (lower) limit wins.
 */
export function mergeConstraints(
  static_: Record<string, { readonly output?: number }>,
  learned: LearnedConstraints,
): Record<string, { readonly output?: number }> {
  const result: Record<string, { readonly output?: number }> = { ...static_ };
  for (const [provider, constraint] of Object.entries(learned)) {
    if (constraint.output !== undefined) {
      const existing = result[provider]?.output;
      result[provider] = {
        output:
          existing !== undefined
            ? Math.min(existing, constraint.output)
            : constraint.output,
      };
    }
  }
  return result;
}
