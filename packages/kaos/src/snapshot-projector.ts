import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Kaos } from './kaos';
import type { MerkleFileIndex, MerkleSnapshot, MerkleFileChange } from './merkle-file-index';
import { MerkleFileIndex as MFI } from './merkle-file-index';

/**
 * Whitelist of environment variables allowed in sandboxed exec.
 * Blocks host process.env leakage.
 */
const SANDBOX_ENV_WHITELIST: readonly string[] = [
  'HOME', 'USER', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM',
  'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH', 'NODE_OPTIONS',
];

/**
 * Build a sandboxed environment by whitelisting only safe variables
 * from the host process.env, then overlaying invocation-specific env.
 */
export function buildSandboxEnv(
  invocationEnv?: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of SANDBOX_ENV_WHITELIST) {
    const val = process.env[key];
    if (val !== undefined) base[key] = val;
  }
  return { ...base, ...invocationEnv };
}

/**
 * Projects a Merkle virtual snapshot into a temporary physical directory,
 * executes commands there, then reverse-projects changes back to the index.
 */
export class SnapshotProjector {
  private _index: MerkleFileIndex;
  private _delegate: Kaos;
  private _shadowDir: string | undefined;

  constructor(index: MerkleFileIndex, delegate: Kaos) {
    this._index = index;
    this._delegate = delegate;
  }

  /**
   * Materialize all files from the index into a temporary directory.
   * @returns The path to the shadow directory.
   */
  async project(): Promise<string> {
    this._shadowDir = await mkdtemp(join(tmpdir(), 'hermetic-shadow-'));

    for (const [relativePath, entry] of this._index.files) {
      const fullPath = join(this._shadowDir, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      const content = this._index.pool.get(entry.contentHash);
      if (content) {
        await writeFile(fullPath, content);
      }
    }

    return this._shadowDir;
  }

  /**
   * Scan the shadow directory for changes and apply them back to the index.
   * @param preExecSnapshot The snapshot captured before exec.
   * @returns The list of changes applied.
   */
  async reverseProjection(preExecSnapshot: MerkleSnapshot): Promise<MerkleFileChange[]> {
    if (!this._shadowDir) throw new Error('Shadow directory not projected');

    const postExecIndex = await MFI.buildFrom(this._delegate, this._shadowDir);
    const postExecSnapshot = postExecIndex.branch();
    const changes = MFI.diff(preExecSnapshot, postExecSnapshot);

    for (const change of changes) {
      if (change.type === 'added' || change.type === 'modified') {
        const content = postExecIndex.getFileContent(change.path);
        if (content !== undefined) {
          this._index.writeFile(change.path, content);
        }
      } else if (change.type === 'deleted') {
        this._index.deleteFile(change.path);
      }
    }

    return changes;
  }

  /**
   * Clean up the shadow directory.
   */
  async dispose(): Promise<void> {
    if (this._shadowDir) {
      await rm(this._shadowDir, { recursive: true, force: true });
      this._shadowDir = undefined;
    }
  }
}
