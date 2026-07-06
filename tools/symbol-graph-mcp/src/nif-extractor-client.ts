/**
 * Client adapter for the nif-extractor (S4) semantic data service.
 *
 * The nif-extractor reads NIF (Neutral Intermediate Format) files produced by
 * the Rust/Swift extraction pipeline and exposes structured symbol data over
 * a simple JSON API. This module wraps that API and normalises the output into
 * the types consumed by the graph query layer.
 *
 * Two modes of operation:
 *  1. **HTTP** – the nif-extractor runs as a long-lived daemon (typical for
 *     IDE integration).
 *  2. **File** – reads NIF JSON files directly from disk (useful for CI or
 *     one-shot analysis).
 *
 * The caller selects the mode via {@link NifExtractorConfig}. When the daemon
 * is unavailable the file-mode fallback kicks in automatically.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  NifSymbolData,
  SymbolNode,
  DependencyEdge,
  SymbolContract,
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NifExtractorConfig {
  /**
   * Base URL of the nif-extractor daemon (e.g. `http://127.0.0.1:9527`).
   * When omitted the client operates in file-only mode.
   */
  daemonUrl?: string;
  /** Timeout in ms for HTTP requests to the daemon. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a single symbol by FQN, optionally recursing `depth` levels into
 * its dependency graph.
 */
export async function querySymbol(
  fqn: string,
  projectPath: string,
  depth: number,
  config: NifExtractorConfig,
): Promise<NifSymbolData[]> {
  const daemon = config.daemonUrl;
  if (daemon !== undefined) {
    try {
      return await querySymbolDaemon(daemon, fqn, projectPath, depth, config.timeoutMs);
    } catch {
      // Daemon unreachable — fall through to file mode.
    }
  }
  return querySymbolFile(fqn, projectPath, depth);
}

/**
 * Resolve a batch of symbols (used by `graph_slice`).
 */
export async function querySymbolsBatch(
  fqnList: string[],
  projectPath: string,
  depth: number,
  config: NifExtractorConfig,
): Promise<NifSymbolData[]> {
  const daemon = config.daemonUrl;
  if (daemon !== undefined) {
    try {
      return await querySymbolsBatchDaemon(daemon, fqnList, projectPath, depth, config.timeoutMs);
    } catch {
      // Fall through to file mode.
    }
  }

  // File mode: query each symbol individually (simpler, no batching in the
  // on-disk format).
  const results: NifSymbolData[] = [];
  for (const fqn of fqnList) {
    const symbols = await querySymbolFile(fqn, projectPath, depth);
    results.push(...symbols);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Daemon (HTTP) transport
// ---------------------------------------------------------------------------

async function querySymbolDaemon(
  daemonUrl: string,
  fqn: string,
  projectPath: string,
  depth: number,
  timeoutMs = 30_000,
): Promise<NifSymbolData[]> {
  const url = new URL('/api/symbol', daemonUrl);
  url.searchParams.set('fqn', fqn);
  url.searchParams.set('project', projectPath);
  url.searchParams.set('depth', String(depth));

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`nif-extractor daemon returned ${String(res.status)}: ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('nif-extractor daemon returned non-array response');
  }
  return data as NifSymbolData[];
}

async function querySymbolsBatchDaemon(
  daemonUrl: string,
  fqnList: string[],
  projectPath: string,
  depth: number,
  timeoutMs = 30_000,
): Promise<NifSymbolData[]> {
  const url = new URL('/api/symbols', daemonUrl);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fqnList, projectPath, depth }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`nif-extractor daemon returned ${String(res.status)}: ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('nif-extractor daemon returned non-array response');
  }
  return data as NifSymbolData[];
}

// ---------------------------------------------------------------------------
// File-mode fallback
// ---------------------------------------------------------------------------

/**
 * Derive the NIF cache path from the project root and FQN.
 *
 * Convention: `<projectPath>/.kimi-code/nif-cache/<fqn-slug>.json`
 * where `fqn-slug` replaces `/` with `__` and strips leading `.`.
 */
function nifFilePath(fqn: string, projectPath: string): string {
  const slug = fqn.replace(/^\.?/, '').replace(/\//g, '__');
  return join(projectPath, '.kimi-code', 'nif-cache', `${slug}.json`);
}

async function querySymbolFile(
  fqn: string,
  projectPath: string,
  _depth: number,
): Promise<NifSymbolData[]> {
  const path = nifFilePath(fqn, projectPath);
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as NifSymbolData[];
    return [parsed as NifSymbolData];
  } catch {
    // File missing or corrupt — return empty so callers get a graceful
    // "not found" instead of a hard crash.
    return [];
  }
}
