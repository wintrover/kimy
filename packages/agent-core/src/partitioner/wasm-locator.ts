/**
 * wasm-locator — tree-sitter-nim WASM binary resolution.
 *
 * Lookup order (first hit wins):
 *   1. KIMI_CODE_HOME/share/ env override
 *   2. ~/.kimi-code/share/ default cache
 *   3. CDN download to <shareDir>/share/ — one-off bootstrap
 *   4. throw with wasmUnavailableMessage()
 *
 * Follows the rg-locator.ts pattern for consistent resolution semantics.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const WASM_FILENAME = 'tree-sitter-nim.wasm';
const CDN_URL = 'https://code.kimi.com/kimi-code/wasm/tree-sitter-nim.wasm';
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type WasmResolutionSource = 'share-cached' | 'share-downloaded';

export interface WasmResolution {
  readonly path: string;
  readonly source: WasmResolutionSource;
}

function getShareDir(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi-code');
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a cached WASM file exists at the expected location.
 * Pure lookup — does not trigger download.
 */
export async function findExistingWasm(shareDir: string): Promise<WasmResolution | undefined> {
  const cachePath = join(shareDir, 'share', WASM_FILENAME);
  if (await isFile(cachePath)) {
    return { path: cachePath, source: 'share-cached' };
  }
  return undefined;
}

/**
 * Download the tree-sitter-nim WASM binary from CDN to shareDir/share/.
 * Serializes concurrent downloads via a module-level promise lock.
 */
let downloadPromise: Promise<WasmResolution> | undefined;

async function downloadWasmWithLock(shareDir: string): Promise<WasmResolution> {
  if (downloadPromise !== undefined) return downloadPromise;
  downloadPromise = (async () => {
    try {
      // Double-check after acquiring the lock
      const existing = await findExistingWasm(shareDir);
      if (existing) return existing;
      const wasmPath = await downloadAndInstallWasm(shareDir);
      return { path: wasmPath, source: 'share-downloaded' };
    } finally {
      downloadPromise = undefined;
    }
  })();
  return downloadPromise;
}

async function downloadAndInstallWasm(shareDir: string): Promise<string> {
  const shareSubdir = join(shareDir, 'share');
  await mkdir(shareSubdir, { recursive: true });

  const tmp = await mkdtemp(join(tmpdir(), 'kimi-wasm-'));
  try {
    const tmpWasmPath = join(tmp, WASM_FILENAME);

    // Download with timeout via AbortController
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(CDN_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!resp.ok || resp.body === null) {
      throw new Error(
        `Failed to download tree-sitter-nim WASM: HTTP ${String(resp.status)} ${resp.statusText}`,
      );
    }
    const write = createWriteStream(tmpWasmPath);
    await pipeline(Readable.fromWeb(resp.body as never), write);

    // Atomic install: write to tmp then rename
    const destination = join(shareSubdir, WASM_FILENAME);
    await rename(tmpWasmPath, destination);
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Resolve the absolute path to the tree-sitter-nim WASM binary,
 * downloading it into <shareDir>/share/ if necessary.
 */
export async function resolveTreeSitterNimWasm(): Promise<string> {
  const shareDir = getShareDir();

  // 1-2. Check cache
  const existing = await findExistingWasm(shareDir);
  if (existing) return existing.path;

  // 3. CDN download
  const downloaded = await downloadWasmWithLock(shareDir);
  return downloaded.path;
}

/**
 * User-facing error message when WASM resolution fails.
 */
export function wasmUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  const sharePath = join(getShareDir(), 'share', WASM_FILENAME);
  return (
    `tree-sitter-nim WASM is not available and automatic download failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  1. Ensure network connectivity and retry\n` +
    `  2. Manually download ${CDN_URL} and place it at ${sharePath}\n` +
    `  3. Set KIMI_CODE_HOME to a directory with share/${WASM_FILENAME}`
  );
}
