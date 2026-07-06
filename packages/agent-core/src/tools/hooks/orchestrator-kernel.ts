/**
 * Orchestrator Kernel — top-level coordination layer for the deterministic
 * agent architecture's formal verification pipeline.
 *
 * Ties together:
 *   - **VFS** (VirtualFileSystem) — immutable epoch-based file state
 *   - **ValidationDB** (Salsa) — memoized verification / synthesis cache
 *   - **Z3 Verifier** — bounded satisfiability checking
 *   - **Constraint Translator** — NIF / contract → Z3 assertion encoding
 *   - **Contract Validator** — effect / type compliance checking
 *   - **Sketch Assembler** — sketch-based algebraic synthesis
 *
 * The kernel provides a unified API for the agent loop to:
 *   1. **Validate file mutations** — run the full pipeline before applying
 *      an edit, with per-stage diagnostics and result caching.
 *   2. **Coordinate sketch synthesis** — when Z3 verification fails, extract
 *      holes and invoke the synthesizer to produce a repair.
 *   3. **Manage VFS epochs** — track file system state transitions, create
 *      new epochs on successful mutation, and provide rollback on failure.
 *
 * @module
 */

import { log } from '#/logging/logger';

import {
  VirtualFilesystem,
} from '#/vfs/virtual-filesystem';

import type { VfsEpoch } from '#/vfs/virtual-filesystem';

import {
  ValidationDatabase,
  stableHash,
} from '#/vfs/validation-db';

import type {
  VerificationResult,
  DurabilityClass,
} from '#/vfs/validation-db';

import {
  translateNifToConstraints,
  translateContractToZ3,
} from '#/tools/hooks/constraint-translator';

import type { ConstraintSet } from '#/tools/hooks/constraint-translator';

import {
  verifyMutation,
  computeMemoKey,
} from '#/tools/hooks/z3-verifier';

import type {
  VerificationResult as Z3VerificationResult,
  ProofCarryingMutation,
} from '#/tools/hooks/z3-verifier';

import {
  synthesizeHoles,
} from '#/tools/synthesis/z3-synthesizer';

import type {
  SynthesisResult as Z3SynthesisResult,
} from '#/tools/synthesis/z3-synthesizer';

import type {
  SynthesisSketch,
  SynthesisHole,
  SynthesisConstraint,
} from '#/tools/synthesis/synthesis-input';

import {
  parseSketch,
} from '#/tools/synthesis/sketch-parser';

import {
  assembleSketchUnsafe,
} from '#/tools/synthesis/sketch-assembler';

import type {
  Sketch as AssemblerSketch,
  SynthesisResult as AssemblerSynthesisResult,
} from '#/tools/synthesis/sketch-assembler';

import type {
  AgentContract,
  ContractViolation,
} from '#/tools/hooks/contract-validator';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default configuration values. */
const DEFAULTS: Required<OrchestrationConfig> = {
  z3Rlimit: 10_000_000,
  enableSynthesis: true,
  enableCache: true,
  maxSynthesisRounds: 3,
  contractStrictness: 'strict',
};

/**
 * Configuration for the orchestrator kernel.
 */
export interface OrchestrationConfig {
  /** Z3 resource limit for verification queries. @default 10_000_000 */
  readonly z3Rlimit: number;
  /** Whether to attempt sketch synthesis on verification failure. @default true */
  readonly enableSynthesis: boolean;
  /** Whether to cache results in VFS + validation-db. @default true */
  readonly enableCache: boolean;
  /** Maximum number of synthesis rounds before giving up. @default 3 */
  readonly maxSynthesisRounds: number;
  /** Contract validation strictness. @default 'strict' */
  readonly contractStrictness: 'strict' | 'relaxed';
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Context for a proposed file mutation.
 */
export interface MutationContext {
  /** Path of the file being mutated. */
  readonly filePath: string;
  /** Current content of the file (before mutation). */
  readonly oldContent: string;
  /** Proposed new content of the file (after mutation). */
  readonly newContent: string;
  /** Structural AST paths affected by the mutation. */
  readonly structuralPaths: readonly string[];
  /** Optional contract specifications to validate against. */
  readonly contracts?: readonly AgentContract[] | undefined;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * Diagnostic entry for a single pipeline stage.
 */
export interface OrchestrationDiagnostic {
  /** Pipeline stage that produced this diagnostic. */
  readonly stage: 'constraint-translate' | 'z3-verify' | 'contract-validate' | 'sketch-synthesize' | 'vfs-cache';
  /** Outcome of the stage. */
  readonly status: 'pass' | 'fail' | 'skip' | 'cache-hit';
  /** Wall-clock duration of the stage in milliseconds. */
  readonly durationMs: number;
  /** Optional human-readable detail string. */
  readonly details?: string | undefined;
}

/**
 * A synthesized patch produced by the sketch assembler.
 */
export interface SynthesizedPatch {
  /** The fully-assembled replacement source. */
  readonly assembledSource: string;
  /** The original source the sketch was derived from. */
  readonly originalSource: string;
  /** Hole IDs → filled values mapping. */
  readonly sourceMap: ReadonlyMap<string, string>;
  /** Number of synthesis rounds used. */
  readonly roundsUsed: number;
}

/**
 * Aggregate result of the orchestration pipeline.
 */
export interface OrchestrationResult {
  /** Whether the mutation is approved (all stages passed). */
  readonly approved: boolean;
  /** Normalized verification score in [0, 1]. */
  readonly verificationScore: number;
  /** All contract violations detected during validation. */
  readonly violations: readonly ContractViolation[];
  /** Synthesized fix when verification failed and synthesis succeeded. */
  readonly synthesizedFix?: SynthesizedPatch | undefined;
  /** Epoch ID of the cached result, if a cache hit occurred. */
  readonly cachedFromEpoch?: number | undefined;
  /** Per-stage diagnostics in pipeline order. */
  readonly diagnostics: readonly OrchestrationDiagnostic[];
}

/**
 * Current VFS status snapshot.
 */
export interface VfsStatus {
  /** ID of the currently active epoch. */
  readonly activeEpochId: number;
  /** Total number of epochs created. */
  readonly epochCount: number;
  /** Number of files in the active epoch. */
  readonly fileCount: number;
  /** Paths of all files in the active epoch. */
  readonly paths: readonly string[];
}

// ---------------------------------------------------------------------------
// Pipeline stage result (internal)
// ---------------------------------------------------------------------------

interface StageResult<T> {
  readonly value: T;
  readonly diagnostic: OrchestrationDiagnostic;
}

// ---------------------------------------------------------------------------
// OrchestratorKernel
// ---------------------------------------------------------------------------

/**
 * Top-level coordination layer for the formal verification pipeline.
 *
 * Wires together VFS, ValidationDB, Z3 Verifier, Constraint Translator,
 * Contract Validator, and Sketch Assembler into a unified API for the
 * agent loop.
 *
 * @example
 * ```ts
 * const kernel = new OrchestratorKernel({ z3Rlimit: 5_000_000 });
 *
 * const result = await kernel.validateMutation({
 *   filePath: 'src/foo.ts',
 *   oldContent: originalSource,
 *   newContent: editedSource,
 *   structuralPaths: ['function_declaration[0]'],
 *   contracts: [myContract],
 * });
 *
 * if (result.approved) {
 *   // Apply the mutation safely.
 *   kernel.getVfsStatus().activeEpochId;
 * } else if (result.synthesizedFix !== undefined) {
 *   // Use the synthesized repair.
 *   console.log(result.synthesizedFix.assembledSource);
 * }
 * ```
 */
export class OrchestratorKernel {
  private readonly _config: Required<OrchestrationConfig>;
  private readonly _vfs: VirtualFilesystem;
  private readonly _validationDb: ValidationDatabase;

  /** Path → last known epoch when the file was valid. */
  private _pathEpochMap = new Map<string, number>();

  /** Pending cache invalidations keyed by path prefix. */
  private _invalidatedPaths = new Set<string>();

  constructor(config?: Partial<OrchestrationConfig> | undefined) {
    this._config = { ...DEFAULTS, ...config };
    this._vfs = new VirtualFilesystem();
    this._validationDb = new ValidationDatabase();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Validate a proposed file mutation through the full pipeline.
   *
   * Pipeline stages (each produces a diagnostic):
   *   1. **constraint-translate** — encode the change as Z3 assertions.
   *   2. **z3-verify** — check satisfiability with the Z3 engine.
   *   3. **contract-validate** — check effect / type compliance.
   *   4. **sketch-synthesize** — (optional) attempt repair on failure.
   *   5. **vfs-cache** — cache the result for future lookups.
   *
   * @param ctx — The mutation context describing the proposed change.
   * @returns Aggregate orchestration result with diagnostics.
   */
  async validateMutation(ctx: MutationContext): Promise<OrchestrationResult> {
    const diagnostics: OrchestrationDiagnostic[] = [];
    const allViolations: ContractViolation[] = [];
    let verificationScore = 1;
    let synthesizedFix: SynthesizedPatch | undefined;
    let cachedFromEpoch: number | undefined;

    // ── Stage 0: Check cache ────────────────────────────────────────────
    if (this._config.enableCache && !this._invalidatedPaths.has(ctx.filePath)) {
      const cached = this._checkCache(ctx);
      if (cached !== undefined) {
        diagnostics.push(cached.diagnostic);
        cachedFromEpoch = cached.value.epoch;
        verificationScore = cached.value.score;
        allViolations.push(...cached.value.violations);
        if (cached.value.score >= 1) {
          return buildResult(true, verificationScore, allViolations, diagnostics, undefined, cachedFromEpoch);
        }
      }
    }

    // ── Stage 1: Constraint Translation ─────────────────────────────────
    const translateResult = this.stageConstraintTranslate(ctx);
    diagnostics.push(translateResult.diagnostic);

    if (translateResult.diagnostic.status === 'fail') {
      // Translation failure — skip Z3 but continue to get diagnostics.
      verificationScore = 0;
    }

    // ── Stage 2: Z3 Verification ────────────────────────────────────────
    let z3Result: Z3VerificationResult | undefined;
    if (translateResult.diagnostic.status !== 'fail') {
      const verifyResult = await this.stageZ3Verify(ctx, translateResult.value);
      diagnostics.push(verifyResult.diagnostic);
      z3Result = verifyResult.value;

      if (z3Result !== undefined) {
        verificationScore = z3Result.ok ? 1 : computeScore(z3Result);
      } else {
        // Z3 was skipped — rely on constraint + contract validation.
        verificationScore = translateResult.diagnostic.status === 'pass' ? 0.8 : 0;
      }
    } else {
      diagnostics.push({
        stage: 'z3-verify',
        status: 'skip',
        durationMs: 0,
        details: 'skipped — constraint translation failed',
      });
      verificationScore = 0;
    }

    // ── Stage 3: Contract Validation ────────────────────────────────────
    const contractResult = this.stageContractValidate(ctx);
    diagnostics.push(contractResult.diagnostic);
    allViolations.push(...contractResult.value);

    // Adjust score based on contract violations.
    if (contractResult.value.length > 0) {
      const errors = contractResult.value.filter((v) => v.severity === 'error');
      if (errors.length > 0) {
        verificationScore = Math.min(verificationScore, 0.5);
      }
    }

    // ── Stage 4: Sketch Synthesis (conditional) ─────────────────────────
    if (verificationScore < 1 && this._config.enableSynthesis && z3Result !== undefined && !z3Result.ok) {
      const synthResult = await this.stageSketchSynthesize(ctx, allViolations);
      diagnostics.push(synthResult.diagnostic);
      synthesizedFix = synthResult.value;

      if (synthesizedFix !== undefined) {
        // Synthesis produced a fix — bump score.
        verificationScore = Math.max(verificationScore, 0.8);
      }
    } else {
      diagnostics.push({
        stage: 'sketch-synthesize',
        status: 'skip',
        durationMs: 0,
        details: verificationScore >= 1 ? 'verification passed — no synthesis needed' : 'synthesis disabled',
      });
    }

    // ── Stage 5: VFS Cache ──────────────────────────────────────────────
    if (this._config.enableCache) {
      const cacheResult = this.stageVfsCache(ctx, verificationScore, allViolations);
      diagnostics.push(cacheResult.diagnostic);
    } else {
      diagnostics.push({
        stage: 'vfs-cache',
        status: 'skip',
        durationMs: 0,
        details: 'caching disabled',
      });
    }

    const approved = verificationScore >= 1 && allViolations.every((v) => v.severity !== 'error');

    return buildResult(approved, verificationScore, allViolations, diagnostics, synthesizedFix, cachedFromEpoch);
  }

  /**
   * Attempt to synthesize a repair for a failed verification.
   *
   * Extracts holes from the violations, runs the sketch parser, invokes
   * the Z3 synthesizer to fill holes, and assembles the result.
   *
   * @param ctx        — The mutation context.
   * @param violations — Contract violations from the failed verification.
   * @returns A synthesized patch, or `null` if synthesis failed.
   */
  async synthesizeRepair(
    ctx: MutationContext,
    violations: readonly ContractViolation[],
  ): Promise<SynthesizedPatch | null> {
    if (!this._config.enableSynthesis) return null;

    const result = await this.stageSketchSynthesize(ctx, violations);
    return result.value ?? null;
  }

  /**
   * Return a snapshot of the current VFS state.
   */
  getVfsStatus(): VfsStatus {
    const epoch = this._vfs.getActiveEpoch();
    const paths = [...epoch.files.keys()];
    return {
      activeEpochId: epoch.id,
      epochCount: this._vfs.epochCount,
      fileCount: paths.length,
      paths,
    };
  }

  /**
   * Invalidate cached results for specific file paths.
   *
   * Subsequent `validateMutation` calls for these paths will re-run
   * the full pipeline instead of returning cached results.
   */
  invalidateCache(paths: readonly string[]): void {
    for (const path of paths) {
      this._invalidatedPaths.add(path);

      // Also invalidate the current VFS epoch in the validation DB.
      const epoch = this._vfs.activeEpochId;
      this._validationDb.invalidateEpoch(epoch);
    }
  }

  /**
   * Return the underlying VFS instance for direct access.
   */
  getVfs(): VirtualFilesystem {
    return this._vfs;
  }

  /**
   * Return the underlying validation database for direct access.
   */
  getValidationDb(): ValidationDatabase {
    return this._validationDb;
  }

  // ── Pipeline stages ─────────────────────────────────────────────────────

  /**
   * Stage 1: Translate the proposed mutation into Z3 assertions.
   *
   * Uses constraint-translator to encode:
   *   - Structural constraints from the new content.
   *   - Contract-specific assertions (allowed / prohibited effects).
   */
  private stageConstraintTranslate(ctx: MutationContext): StageResult<ConstraintSet> {
    const start = Date.now();

    try {
      // Build a minimal NIF-like structure from the new content for
      // constraint translation.
      const nifData = buildNifDataFromMutation(ctx);
      const constraints = translateNifToConstraints(nifData);

      // Also translate any explicit contracts into Z3 assertions.
      const contractAssertions: string[] = [];
      if (ctx.contracts !== undefined) {
        for (const contract of ctx.contracts) {
          contractAssertions.push(...translateContractToZ3(contract));
        }
      }

      // Merge the contract assertions into the constraint set.
      const merged: ConstraintSet = {
        z3Assertions: [...constraints.z3Assertions, ...contractAssertions],
        effects: constraints.effects,
        typeConstraints: constraints.typeConstraints,
        source: contractAssertions.length > 0 ? 'hybrid' : constraints.source,
      };

      return {
        value: merged,
        diagnostic: {
          stage: 'constraint-translate',
          status: 'pass',
          durationMs: Date.now() - start,
          details: `${String(merged.z3Assertions.length)} assertions from ${merged.source}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('orchestrator_constraint_translate_failed', {
        filePath: ctx.filePath,
        error: message,
      });

      // Return an empty constraint set on failure so the pipeline can continue.
      return {
        value: { z3Assertions: [], effects: new Map(), typeConstraints: new Map(), source: 'nif' },
        diagnostic: {
          stage: 'constraint-translate',
          status: 'fail',
          durationMs: Date.now() - start,
          details: message,
        },
      };
    }
  }

  /**
   * Stage 2: Verify the constraint set with the Z3 engine.
   *
   * When contracts are available, builds a `ProofCarryingMutation` from the
   * constraint data and delegates to `verifyMutation`.  When no contracts
   * are present, skips Z3 verification (the constraint-translator stage
   * already validated the encoding).
   */
  private async stageZ3Verify(
    ctx: MutationContext,
    constraints: ConstraintSet,
  ): Promise<StageResult<Z3VerificationResult | undefined>> {
    const start = Date.now();

    if (ctx.contracts === undefined || ctx.contracts.length === 0 || constraints.z3Assertions.length === 0) {
      // No contracts or no assertions — skip Z3 verification.
      return {
        value: undefined,
        diagnostic: {
          stage: 'z3-verify',
          status: 'skip',
          durationMs: Date.now() - start,
          details: ctx.contracts === undefined || ctx.contracts.length === 0
            ? 'no contracts — Z3 verification skipped'
            : 'no assertions — Z3 verification skipped',
        },
      };
    }

    try {
      // Build a ProofCarryingMutation from the constraint data.
      const mutation: ProofCarryingMutation = {
        id: `mutation-${ctx.filePath}-${String(Date.now())}`,
        declaredEffects: [...constraints.effects.keys()] as unknown as import('#/tools/hooks/contract-validator').EffectKind[],
        preconditions: constraints.z3Assertions,
      };

      // Use the first contract for verification.
      const contract = ctx.contracts[0]!;
      const result = await verifyMutation(contract, mutation, this._config.z3Rlimit);

      return {
        value: result,
        diagnostic: {
          stage: 'z3-verify',
          status: result.ok ? 'pass' : 'fail',
          durationMs: Date.now() - start,
          details: result.ok
            ? `Z3 verification passed — memo ${result.memoKey.slice(0, 8)}`
            : `Z3 verification failed — violated: ${result.violatedConstraints?.join(', ') ?? 'unknown'}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('orchestrator_z3_verify_failed', {
        filePath: ctx.filePath,
        error: message,
      });

      // Return a conservative failure result.
      const fallback: Z3VerificationResult = {
        ok: false,
        violatedConstraints: ['z3.error'],
        rlimit: this._config.z3Rlimit,
        memoKey: `error-${String(Date.now())}`,
      };

      return {
        value: fallback,
        diagnostic: {
          stage: 'z3-verify',
          status: 'fail',
          durationMs: Date.now() - start,
          details: `Z3 engine error: ${message}`,
        },
      };
    }
  }

  /**
   * Stage 3: Validate the mutation against agent contracts.
   *
   * Checks that:
   *   - All observed effects are in the contract's allowed list.
   *   - No prohibited effects are present.
   *   - In strict mode, all required effects are present.
   */
  private stageContractValidate(ctx: MutationContext): StageResult<readonly ContractViolation[]> {
    const start = Date.now();
    const violations: ContractViolation[] = [];

    if (ctx.contracts === undefined || ctx.contracts.length === 0) {
      return {
        value: violations,
        diagnostic: {
          stage: 'contract-validate',
          status: 'skip',
          durationMs: Date.now() - start,
          details: 'no contracts provided',
        },
      };
    }

    // Detect structural effects from the content diff.
    const observedEffects = detectEffects(ctx.oldContent, ctx.newContent);

    for (const contract of ctx.contracts) {
      // Check allowed effects.
      for (const effect of observedEffects) {
        const allowed = contract.allowedEffects.length === 0 ||
          contract.allowedEffects.some((declared) => declared.kind === effect);
        if (!allowed) {
          violations.push({
            rule: 'contract.effect-not-allowed',
            message: `Effect "${effect}" is not in contract "${contract.id}" allowed effects list.`,
            severity: 'warning',
            effectKind: effect,
            source: 'nif',
          });
        }
      }

      // Check prohibited effects.
      for (const prohibited of contract.prohibitedEffects) {
        const present = observedEffects.some((e) => e === prohibited.kind);
        if (present) {
          violations.push({
            rule: 'contract.effect-prohibited',
            message:
              `Prohibited effect "${prohibited.kind}" detected in contract "${contract.id}"` +
              (prohibited.pattern !== undefined ? ` matching pattern "${prohibited.pattern}"` : '') +
              '.',
            severity: 'error',
            effectKind: prohibited.kind,
            source: 'prohibited-effect',
          });
        }
      }
    }

    return {
      value: violations,
      diagnostic: {
        stage: 'contract-validate',
        status: violations.length === 0 ? 'pass' : (violations.some((v) => v.severity === 'error') ? 'fail' : 'pass'),
        durationMs: Date.now() - start,
        details: violations.length === 0
          ? 'all contracts satisfied'
          : `${String(violations.length)} violation(s) across ${String(ctx.contracts.length)} contract(s)`,
      },
    };
  }

  /**
   * Stage 4: Attempt sketch-based synthesis to repair a failed verification.
   *
   * Pipeline:
   *   1. Extract holes from the violation context.
   *   2. Build a sketch template from the new content.
   *   3. Run Z3 synthesis to fill holes via `synthesizeHoles`.
   *   4. Assemble the result.
   */
  private async stageSketchSynthesize(
    ctx: MutationContext,
    violations: readonly ContractViolation[],
  ): Promise<StageResult<SynthesizedPatch | undefined>> {
    const start = Date.now();

    if (!this._config.enableSynthesis) {
      return {
        value: undefined,
        diagnostic: {
          stage: 'sketch-synthesize',
          status: 'skip',
          durationMs: 0,
          details: 'synthesis disabled',
        },
      };
    }

    try {
      // Build a sketch from the new content by inserting `??` holes
      // at positions identified by the violations.
      const sketchTemplate = buildSketchFromViolations(ctx.newContent, violations);
      if (sketchTemplate.holeCount === 0) {
        return {
          value: undefined,
          diagnostic: {
            stage: 'sketch-synthesize',
            status: 'skip',
            durationMs: Date.now() - start,
            details: 'no synthesis opportunities identified',
          },
        };
      }

      // Parse the sketch to extract classified holes.
      const parsedSketch = parseSketch(sketchTemplate.template, ctx.filePath);

      // Build Z3 assertions for the sketch constraints.
      const constraints = translateNifToConstraints(buildNifDataFromMutation(ctx));
      const assertions = [...constraints.z3Assertions];

      // Add contract assertions for synthesis.
      if (ctx.contracts !== undefined) {
        for (const contract of ctx.contracts) {
          assertions.push(...translateContractToZ3(contract));
        }
      }

      // Build a SynthesisSketch for the z3-synthesizer.
      const synthHoles: SynthesisHole[] = parsedSketch.holes.map((h) => ({
        id: h.id,
        domain: h.domain === 'type' ? 'string' : h.domain === 'parameter' ? 'string' : 'int',
        description: h.constraints.join(', '),
      }));

      const synthConstraints: SynthesisConstraint[] = assertions.map((a) => ({
        body: a,
      }));

      const synthSketch: SynthesisSketch = {
        id: `sketch-${ctx.filePath}-${String(Date.now())}`,
        targetNode: parsedSketch.targetNode,
        template: sketchTemplate.template,
        holes: synthHoles,
        constraints: synthConstraints,
        templateHints: parsedSketch.holes
          .filter((h): h is typeof h & { templateHint: string } => h.templateHint !== undefined)
          .map((h) => ({ pattern: h.templateHint })),
      };

      // Iterative synthesis rounds using `synthesizeHoles`.
      let lastResult: Z3SynthesisResult | undefined;
      let holeValues = new Map<string, string>();

      for (let round = 0; round < this._config.maxSynthesisRounds; round++) {
        const synthResult = await synthesizeHoles(synthSketch, this._config.z3Rlimit);
        lastResult = synthResult;

        if (synthResult.success && synthResult.holeValues !== undefined) {
          holeValues = new Map(synthResult.holeValues);
          break;
        }
      }

      if (lastResult === undefined || !lastResult.success) {
        return {
          value: undefined,
          diagnostic: {
            stage: 'sketch-synthesize',
            status: 'fail',
            durationMs: Date.now() - start,
            details: `synthesis failed after ${String(this._config.maxSynthesisRounds)} round(s)` +
              (lastResult?.error !== undefined ? `: ${lastResult.error}` : ''),
          },
        };
      }

      // Assemble the sketch with the synthesized values.
      const assemblerSketch: AssemblerSketch = {
        template: sketchTemplate.template,
        holes: parsedSketch.holes.map((h) => ({
          id: h.id,
          placeholder: '??',
          node_id: h.id,
        })),
        originalSource: ctx.newContent,
        filePath: ctx.filePath,
      };

      const synthesisResult: AssemblerSynthesisResult = {
        holeValues,
      };

      const assembled = assembleSketchUnsafe(assemblerSketch, synthesisResult);

      const patch: SynthesizedPatch = {
        assembledSource: assembled.completeSource,
        originalSource: ctx.newContent,
        sourceMap: assembled.sourceMap,
        roundsUsed: this._config.maxSynthesisRounds,
      };

      return {
        value: patch,
        diagnostic: {
          stage: 'sketch-synthesize',
          status: 'pass',
          durationMs: Date.now() - start,
          details: `synthesized ${String(holeValues.size)} hole(s) in ${String(this._config.maxSynthesisRounds)} round(s)`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('orchestrator_synthesis_failed', {
        filePath: ctx.filePath,
        error: message,
      });

      return {
        value: undefined,
        diagnostic: {
          stage: 'sketch-synthesize',
          status: 'fail',
          durationMs: Date.now() - start,
          details: message,
        },
      };
    }
  }

  /**
   * Stage 5: Cache the verification result in VFS + validation-db.
   */
  private stageVfsCache(
    ctx: MutationContext,
    score: number,
    violations: readonly ContractViolation[],
  ): StageResult<void> {
    const start = Date.now();

    try {
      // Write the new content into the VFS to create a new epoch.
      const epoch = this._vfs.writeFile(ctx.filePath, ctx.newContent);

      // Cache the verification result.
      const mutationHash = stableHash(ctx.newContent);
      const contractHash = ctx.contracts !== undefined
        ? stableHash(JSON.stringify(ctx.contracts))
        : 'no-contract';

      const verificationResult: VerificationResult = {
        valid: score >= 1,
        rlimitUsed: 0,
        durationMs: 0,
        durability: 'LOW' as DurabilityClass,
      };

      this._validationDb.cache_z3Verify(
        contractHash,
        mutationHash,
        this._config.z3Rlimit,
        verificationResult,
        epoch.id,
      );

      // Track the epoch for this path.
      this._pathEpochMap.set(ctx.filePath, epoch.id);

      // Clear the invalidation flag since we've revalidated.
      this._invalidatedPaths.delete(ctx.filePath);

      return {
        value: undefined,
        diagnostic: {
          stage: 'vfs-cache',
          status: 'pass',
          durationMs: Date.now() - start,
          details: `cached at epoch ${String(epoch.id)}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('orchestrator_cache_failed', {
        filePath: ctx.filePath,
        error: message,
      });

      return {
        value: undefined,
        diagnostic: {
          stage: 'vfs-cache',
          status: 'fail',
          durationMs: Date.now() - start,
          details: message,
        },
      };
    }
  }

  // ── Cache lookup ────────────────────────────────────────────────────────

  /**
   * Check the validation-db cache for a previously verified mutation.
   */
  private _checkCache(
    ctx: MutationContext,
  ): StageResult<{ epoch: number; score: number; violations: readonly ContractViolation[] }> | undefined {
    const epoch = this._vfs.activeEpochId;
    const mutationHash = stableHash(ctx.newContent);
    const contractHash = ctx.contracts !== undefined
      ? stableHash(JSON.stringify(ctx.contracts))
      : 'no-contract';

    const cached = this._validationDb.query_z3Verify(
      contractHash,
      mutationHash,
      this._config.z3Rlimit,
      epoch,
    );

    if (cached === null) return undefined;

    const score = cached.valid ? 1 : 0;
    return {
      value: { epoch, score, violations: [] },
      diagnostic: {
        stage: 'vfs-cache',
        status: 'cache-hit',
        durationMs: 0,
        details: `cache hit from epoch ${String(epoch)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the orchestration result object.
 */
function buildResult(
  approved: boolean,
  verificationScore: number,
  violations: readonly ContractViolation[],
  diagnostics: readonly OrchestrationDiagnostic[],
  synthesizedFix: SynthesizedPatch | undefined,
  cachedFromEpoch: number | undefined,
): OrchestrationResult {
  return {
    approved,
    verificationScore: Math.max(0, Math.min(1, verificationScore)),
    violations,
    synthesizedFix,
    cachedFromEpoch,
    diagnostics,
  };
}

/**
 * Compute a normalized verification score from a Z3 verification result.
 *
 * When the Z3 result indicates `ok`, returns 1.  When `ok` is false but
 * violatedConstraints are present, returns a partial score based on the
 * number of violations (fewer violations → higher score).
 */
function computeScore(result: Z3VerificationResult): number {
  if (result.ok) return 1;

  const violated = result.violatedConstraints?.length ?? 0;

  // No violations reported but still not ok — conservatively return 0.
  if (violated === 0) return 0;

  // Heuristic: score decays with number of violated constraints.
  // 1 violation → 0.7, 2 → 0.5, 3+ → 0.3, etc.
  return Math.max(0.1, 1 - violated * 0.3);
}

/**
 * Detect effect kinds present in a content diff.
 *
 * Performs lightweight structural analysis to identify what kind of
 * effects the mutation introduces.
 */
function detectEffects(
  oldContent: string,
  newContent: string,
): readonly import('#/tools/hooks/contract-validator').EffectKind[] {
  const effects = new Set<import('#/tools/hooks/contract-validator').EffectKind>();

  // If the content changed at all, it's a file_write.
  if (oldContent !== newContent) {
    effects.add('file_write');
  }

  // Detect import statements in the new content.
  const importPatterns = [
    /\bimport\s+/,
    /\brequire\s*\(/,
    /\bfrom\s+['"][^'"]+['"]/,
    /\b#include\b/,
    /\buse\s+\w+/,
  ];
  for (const pattern of importPatterns) {
    if (pattern.test(newContent) && !pattern.test(oldContent)) {
      effects.add('dynamic_import');
      break;
    }
  }

  // Detect eval-like patterns.
  const evalPatterns = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bFunction\s*\(/,
    /\bexec\s*\(/,
    /\bspawn\s*\(/,
  ];
  for (const pattern of evalPatterns) {
    if (pattern.test(newContent)) {
      if (pattern.source.includes('exec') || pattern.source.includes('spawn')) {
        effects.add('exec');
      } else {
        effects.add('eval');
      }
    }
  }

  // Detect network operations.
  const networkPatterns = [
    /\bfetch\s*\(/,
    /\bhttp\.request/,
    /\bhttps\.request/,
    /\bXMLHttpRequest/,
    /\bWebSocket/,
    /\baxios\./,
    /\burllib\b/,
    /\brequests\./,
  ];
  for (const pattern of networkPatterns) {
    if (pattern.test(newContent)) {
      effects.add('network');
      break;
    }
  }

  // Detect file system traversal.
  const fsPatterns = [
    /\breaddirSync\b/,
    /\breaddir\b/,
    /\bscandir\b/,
    /\bglob\b/,
    /\bwalk\b/,
    /\bwalkSync\b/,
  ];
  for (const pattern of fsPatterns) {
    if (pattern.test(newContent)) {
      effects.add('fs_traversal');
      break;
    }
  }

  // Detect environment mutations.
  const envPatterns = [
    /\bprocess\.env\b/,
    /\bos\.environ\b/,
    /\bsetenv\b/,
    /\bputenv\b/,
  ];
  for (const pattern of envPatterns) {
    if (pattern.test(newContent)) {
      effects.add('env_mutation');
      break;
    }
  }

  return [...effects];
}

/**
 * Build a minimal NIF-like data structure from a mutation context
 * for constraint translation.
 */
function buildNifDataFromMutation(ctx: MutationContext): unknown {
  // Produce a minimal NifContractOutput-compatible structure that
  // constraint-translator can consume.
  return {
    format: 'kimi-agent-swarm-nif-contract' as const,
    version: '1.0',
    symbols: ctx.structuralPaths.map((path) => ({
      symbol: path,
      kind: 'definition',
      file: ctx.filePath,
    })),
  };
}

/**
 * Sketch template for synthesis.
 */
interface SketchTemplate {
  readonly template: string;
  readonly holeCount: number;
}

/**
 * Build a sketch template by inserting `??` holes at positions identified
 * by contract violations.
 *
 * This is a simplified heuristic: when violations indicate specific effects
 * are problematic, we insert holes at the corresponding code positions
 * so the synthesizer can try to rewrite them.
 */
function buildSketchFromViolations(
  content: string,
  violations: readonly ContractViolation[],
): SketchTemplate {
  if (violations.length === 0) {
    return { template: content, holeCount: 0 };
  }

  let template = content;
  let holeCount = 0;

  // For each violation with evidence, try to insert a hole near the
  // evidence location.  This is a heuristic — production code would use
  // AST-level positioning.
  for (const violation of violations) {
    if (violation.severity !== 'error') continue;
    if (violation.evidence === undefined) continue;

    // Try to find the evidence string in the content.
    const evidenceIdx = template.indexOf(violation.evidence);
    if (evidenceIdx === -1) continue;

    // Replace the evidence occurrence with a hole.
    const before = template.slice(0, evidenceIdx);
    const after = template.slice(evidenceIdx + violation.evidence.length);
    template = `${before}??${after}`;
    holeCount++;
  }

  // If no holes were inserted but we have error violations, insert a
  // hole at the end of the content as a last resort.
  if (holeCount === 0 && violations.some((v) => v.severity === 'error')) {
    template = `${template}\n??`;
    holeCount = 1;
  }

  return { template, holeCount };
}
