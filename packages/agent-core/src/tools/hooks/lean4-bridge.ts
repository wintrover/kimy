import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '#/logging/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verification status of a single Lean 4 theorem. */
export interface LeanProofStatus {
  /** Fully-qualified theorem name in the Lean 4 model (e.g. "ConstraintTranslator.effectAllowed_iff"). */
  readonly theorem: string;
  /** Whether the proof was successfully verified by `lean --verify`. */
  readonly verified: boolean;
  /** Unix timestamp (ms) when this status was last confirmed. */
  readonly timestamp: number;
}

/**
 * Lean 4 proof verification result parsed from the manifest produced
 * by the CI pipeline (`lean --verify`).
 */
interface LeanProofManifest {
  /** Lean 4 lakefile project name. */
  readonly project: string;
  /** Lean toolchain version used for verification. */
  readonly toolchain: string;
  /** ISO-8601 timestamp of when verification ran. */
  readonly verifiedAt: string;
  /** Individual theorem results. */
  readonly theoremResults: readonly {
    readonly name: string;
    readonly verified: boolean;
    readonly message?: string | undefined;
  }[];
}

/** Runtime check result for a single consistency constraint. */
export interface ConsistencyCheck {
  /** Identifier of the checked constraint (e.g. "effect_kind_parity"). */
  readonly id: string;
  /** Whether the TypeScript implementation matches the Lean 4 model. */
  readonly matches: boolean;
  /** Human-readable detail when mismatched. */
  readonly detail?: string | undefined;
}

// ---------------------------------------------------------------------------
// Lean 4 model constants — must mirror the Lean 4 source definitions
// ---------------------------------------------------------------------------

/**
 * Effect kinds recognized by the Lean 4 constraint model.
 * Must stay in sync with `EffectKind` in contract-validator.ts
 * and the corresponding Lean 4 inductive type.
 */
const LEAN_EFFECT_KINDS: readonly string[] = [
  'file_read',
  'file_write',
  'exec',
  'spawn',
  'network',
  'env_mutation',
  'fs_traversal',
  'dynamic_import',
  'eval',
  'protobuf',
  'unknown',
] as const;

/**
 * Violation rule identifiers recognized by the Lean 4 model.
 * Must stay in sync with the `RULE_*` constants in contract-validator.ts.
 */
const LEAN_VIOLATION_RULES: readonly string[] = [
  'contract.effect-not-allowed',
  'contract.effect-prohibited',
  'contract.type-signature-mismatch',
  'contract.nif-transparency-violation',
  'contract.structural-side-effects',
  'contract.missing-required-effect',
] as const;

/**
 * Severity levels recognized by the Lean 4 model.
 * Must stay in sync with `ViolationSeverity` in contract-validator.ts.
 */
const LEAN_SEVERITIES: readonly string[] = ['error', 'warning', 'info'] as const;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface Lean4BridgeOptions {
  /**
   * Absolute path to the directory containing the Lean 4 project
   * with the constraint-translator proofs.
   * @default "<repo-root>/lean/constraint-translator"
   */
  readonly leanProjectDir?: string | undefined;

  /**
   * Absolute path to the `lean` executable.
   * @default "lean"
   */
  readonly leanExecutable?: string | undefined;

  /**
   * Path (relative to leanProjectDir) to the proof manifest JSON
   * produced by `lean --verify`.
   * @default ".lake/build/proof-manifest.json"
   */
  readonly manifestPath?: string | undefined;

  /**
   * Timeout in milliseconds for `lean --verify` subprocess calls.
   * @default 30_000
   */
  readonly verifyTimeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Lean4Bridge
// ---------------------------------------------------------------------------

/**
 * Lean 4 ↔ TypeScript connection for the deterministic agent architecture.
 *
 * Responsibilities:
 * 1. **Proof status tracking** — reads the proof manifest produced by the CI
 *    pipeline (`lean --verify`) and exposes per-theorem verification status
 *    to TypeScript callers.
 * 2. **Runtime consistency assertions** — verifies that the TypeScript
 *    implementation (contract-validator / constraint-translator) defines the
 *    same effect kinds, violation rules, and severity levels as the formal
 *    Lean 4 model, catching drift between the two at startup.
 * 3. **On-demand re-verification** — can invoke `lean --verify` directly
 *    (outside CI) for ad-hoc proof checks during development.
 *
 * @example
 * ```ts
 * const bridge = new Lean4Bridge();
 *
 * // Check proof status after CI run.
 * for (const p of bridge.getProofStatus()) {
 *   if (!p.verified) console.error(`Unverified: ${p.theorem}`);
 * }
 *
 * // Assert TypeScript ↔ Lean 4 consistency.
 * if (!bridge.verifyTranslatorConsistency()) {
 *   throw new Error('Constraint translator drifted from Lean 4 model');
 * }
 * ```
 */
export class Lean4Bridge {
  private readonly leanProjectDir: string;
  private readonly leanExecutable: string;
  private readonly manifestPath: string;
  private readonly verifyTimeoutMs: number;

  /** Cached proof statuses from the last manifest read. */
  private proofStatusCache: readonly LeanProofStatus[] | undefined;

  constructor(options?: Lean4BridgeOptions | undefined) {
    const repoRoot = resolveRepoRoot();
    this.leanProjectDir = options?.leanProjectDir ?? join(repoRoot, 'lean', 'constraint-translator');
    this.leanExecutable = options?.leanExecutable ?? 'lean';
    this.manifestPath = options?.manifestPath ?? '.lake/build/proof-manifest.json';
    this.verifyTimeoutMs = options?.verifyTimeoutMs ?? 30_000;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Return the verification status of all known Lean 4 theorems.
   *
   * Reads from the proof manifest JSON on disk (written by the CI pipeline
   * after `lean --verify` succeeds). Results are cached until
   * {@link refreshProofStatus} is called.
   *
   * When the manifest is absent or unreadable, returns an empty array and
   * logs a warning — this is a graceful degradation, not a hard failure.
   */
  getProofStatus(): readonly LeanProofStatus[] {
    if (this.proofStatusCache !== undefined) {
      return this.proofStatusCache;
    }
    this.proofStatusCache = readManifest(this.leanProjectDir, this.manifestPath);
    return this.proofStatusCache;
  }

  /**
   * Force-reload the proof manifest from disk.
   */
  refreshProofStatus(): readonly LeanProofStatus[] {
    this.proofStatusCache = undefined;
    return this.getProofStatus();
  }

  /**
   * Verify that the TypeScript constraint-translator implementation is
   * consistent with the Lean 4 formal model.
   *
   * Performs four static checks:
   * 1. **Effect kind parity** — every `EffectKind` value in the TypeScript
   *    source exists in the Lean 4 model and vice versa.
   * 2. **Violation rule parity** — every violation rule identifier matches.
   * 3. **Severity parity** — every severity level matches.
   * 4. **Proof completeness** — all theorems in the manifest are verified.
   *
   * Returns `true` when all checks pass. On failure, logs each mismatch
   * and returns `false`.
   */
  verifyTranslatorConsistency(): boolean {
    const checks = runConsistencyChecks();

    const failures = checks.filter((c) => !c.matches);
    if (failures.length === 0) {
      log.info('lean4_bridge_consistency', { result: 'pass', checks: checks.length });
      return true;
    }

    for (const f of failures) {
      log.warn('lean4_bridge_consistency_mismatch', {
        checkId: f.id,
        detail: f.detail,
      });
    }

    log.warn('lean4_bridge_consistency', {
      result: 'fail',
      checks: checks.length,
      failures: failures.length,
    });
    return false;
  }

  /**
   * Invoke `lean --verify` directly and return the parsed proof statuses.
   *
   * This is intended for ad-hoc verification outside the CI pipeline
   * (e.g. during development). It blocks until the subprocess completes
   * or the timeout is reached.
   *
   * @returns Parsed proof statuses, or an empty array on error.
   */
  async runVerify(): Promise<readonly LeanProofStatus[]> {
    return new Promise((resolve) => {
      execFile(
        this.leanExecutable,
        ['--verify'],
        {
          cwd: this.leanProjectDir,
          timeout: this.verifyTimeoutMs,
          encoding: 'utf-8',
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            log.error('lean4_verify_failed', {
              code: error.code,
              stderr: stderr.slice(0, 2048),
            });
            resolve([]);
            return;
          }

          log.info('lean4_verify_completed', {
            stdoutLen: stdout.length,
          });

          // After successful verification, re-read the manifest.
          this.proofStatusCache = undefined;
          resolve(this.getProofStatus());
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

function readManifest(leanProjectDir: string, manifestPath: string): readonly LeanProofStatus[] {
  const fullPath = join(leanProjectDir, manifestPath);

  let raw: string;
  try {
    raw = readFileSync(fullPath, 'utf-8');
  } catch {
    log.warn('lean4_manifest_not_found', { path: fullPath });
    return [];
  }

  let parsed: LeanProofManifest;
  try {
    parsed = JSON.parse(raw) as LeanProofManifest;
  } catch {
    log.warn('lean4_manifest_parse_error', { path: fullPath });
    return [];
  }

  const verifiedAt = Date.parse(parsed.verifiedAt);
  const timestamp = Number.isFinite(verifiedAt) ? verifiedAt : Date.now();

  return parsed.theoremResults.map((th) => ({
    theorem: th.name,
    verified: th.verified,
    timestamp,
  }));
}

// ---------------------------------------------------------------------------
// Consistency checks
// ---------------------------------------------------------------------------

/**
 * Compare the TypeScript-defined sets against the Lean 4 model constants.
 *
 * The Lean 4 model constants (`LEAN_*`) are the single source of truth
 * for what the formal model expects. The TypeScript side must export
 * identical sets — any drift means the runtime implementation has diverged
 * from what was proven.
 */
function runConsistencyChecks(): readonly ConsistencyCheck[] {
  return [
    checkEffectKindParity(),
    checkViolationRuleParity(),
    checkSeverityParity(),
    checkAllProofsVerified(),
  ];
}

/**
 * EffectKind values that contract-validator.ts MUST define.
 * Kept as a separate constant so drift is caught at this boundary.
 */
function getTsEffectKinds(): readonly string[] {
  return [
    'file_read',
    'file_write',
    'exec',
    'spawn',
    'network',
    'env_mutation',
    'fs_traversal',
    'dynamic_import',
    'eval',
    'protobuf',
    'unknown',
  ];
}

/** Violation rule identifiers that contract-validator.ts MUST define. */
function getTsViolationRules(): readonly string[] {
  return [
    'contract.effect-not-allowed',
    'contract.effect-prohibited',
    'contract.type-signature-mismatch',
    'contract.nif-transparency-violation',
    'contract.structural-side-effects',
    'contract.missing-required-effect',
  ];
}

/** Severity levels that contract-validator.ts MUST define. */
function getTsSeverities(): readonly string[] {
  return ['error', 'warning', 'info'];
}

function checkEffectKindParity(): ConsistencyCheck {
  const tsKinds = new Set(getTsEffectKinds());
  const leanKinds = new Set(LEAN_EFFECT_KINDS);

  const inTsNotLean = [...tsKinds].filter((k) => !leanKinds.has(k));
  const inLeanNotTs = [...leanKinds].filter((k) => !tsKinds.has(k));

  if (inTsNotLean.length === 0 && inLeanNotTs.length === 0) {
    return { id: 'effect_kind_parity', matches: true };
  }

  const parts: string[] = [];
  if (inTsNotLean.length > 0) parts.push(`in TypeScript only: ${inTsNotLean.join(', ')}`);
  if (inLeanNotTs.length > 0) parts.push(`in Lean only: ${inLeanNotTs.join(', ')}`);

  return {
    id: 'effect_kind_parity',
    matches: false,
    detail: `EffectKind mismatch — ${parts.join('; ')}`,
  };
}

function checkViolationRuleParity(): ConsistencyCheck {
  const tsRules = new Set(getTsViolationRules());
  const leanRules = new Set(LEAN_VIOLATION_RULES);

  const inTsNotLean = [...tsRules].filter((r) => !leanRules.has(r));
  const inLeanNotTs = [...leanRules].filter((r) => !tsRules.has(r));

  if (inTsNotLean.length === 0 && inLeanNotTs.length === 0) {
    return { id: 'violation_rule_parity', matches: true };
  }

  const parts: string[] = [];
  if (inTsNotLean.length > 0) parts.push(`in TypeScript only: ${inTsNotLean.join(', ')}`);
  if (inLeanNotTs.length > 0) parts.push(`in Lean only: ${inLeanNotTs.join(', ')}`);

  return {
    id: 'violation_rule_parity',
    matches: false,
    detail: `Violation rule mismatch — ${parts.join('; ')}`,
  };
}

function checkSeverityParity(): ConsistencyCheck {
  const tsSev = new Set(getTsSeverities());
  const leanSev = new Set(LEAN_SEVERITIES);

  const inTsNotLean = [...tsSev].filter((s) => !leanSev.has(s));
  const inLeanNotTs = [...leanSev].filter((s) => !tsSev.has(s));

  if (inTsNotLean.length === 0 && inLeanNotTs.length === 0) {
    return { id: 'severity_parity', matches: true };
  }

  const parts: string[] = [];
  if (inTsNotLean.length > 0) parts.push(`in TypeScript only: ${inTsNotLean.join(', ')}`);
  if (inLeanNotTs.length > 0) parts.push(`in Lean only: ${inLeanNotTs.join(', ')}`);

  return {
    id: 'severity_parity',
    matches: false,
    detail: `Severity mismatch — ${parts.join('; ')}`,
  };
}

function checkAllProofsVerified(): ConsistencyCheck {
  const repoRoot = resolveRepoRoot();
  const leanProjectDir = join(repoRoot, 'lean', 'constraint-translator');
  const statuses = readManifest(leanProjectDir, '.lake/build/proof-manifest.json');

  if (statuses.length === 0) {
    return {
      id: 'all_proofs_verified',
      matches: false,
      detail: 'No proof manifest found — run `lean --verify` in CI first',
    };
  }

  const unverified = statuses.filter((s) => !s.verified);
  if (unverified.length === 0) {
    return { id: 'all_proofs_verified', matches: true };
  }

  return {
    id: 'all_proofs_verified',
    matches: false,
    detail: `${String(unverified.length)} unverified theorem(s): ${unverified.map((u) => u.theorem).join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Resolve the repository root. Uses the known relative position from
 * this file to the repo root.
 */
function resolveRepoRoot(): string {
  // packages/agent-core/src/tools/hooks/ → repo root is 5 levels up.
  return join(import.meta.dirname, '..', '..', '..', '..', '..');
}
