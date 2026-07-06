/**
 * Z3 rlimit deterministic in-memory verification engine.
 *
 * Uses the `z3-solver` WASM bindings to verify that a proof-carrying
 * mutation satisfies an agent contract.  The solver is configured with
 * a mandatory resource-limit (`rlimit`) instead of wall-clock timeouts
 * so that verification is deterministic and host-independent.
 *
 * ### Verification encoding
 *
 * The engine checks: *"can the mutation produce a state that violates
 * the contract?"*
 *
 *   1. Effect variables `e_k` (one Boolean per `EffectKind`) model which
 *      effects actually occur.
 *   2. Mutation constraints assert that declared effects fire and that
 *      resource bounds / pre/post-conditions hold.
 *   3. A **violation condition** asserts that at least one effect is
 *      prohibited or not in the allowed set.
 *   4. If the solver returns **UNSAT** the violation is impossible → `ok`.
 *      If **SAT** a counterexample exists → `!ok`.
 *
 * The rlimit value is baked into the `memoKey` so that callers can cache
 * results per (contract × mutation × rlimit) triple.
 *
 * ### Synchronous vs asynchronous API
 *
 *   - **`Z3Verifier`** — synchronous lightweight contract checking used by
 *     the orchestrator pipeline.  Compares declared effect sets against
 *     contract allowed/prohibited lists without invoking the WASM solver.
 *   - **`verifyMutation()`** — async, full Z3 WASM verification with
 *     rlimit-bounded solving, SMT-LIB2 pre/postcondition parsing, and
 *     unsat-core extraction.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { log } from '../../logging/logger';
import type { AgentContract, EffectKind } from './contract-validator';

// ---------------------------------------------------------------------------
// Effect kind catalogue (mirrors contract-validator)
// ---------------------------------------------------------------------------

/** Every recognised effect kind. */
const ALL_EFFECT_KINDS: readonly EffectKind[] = [
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

// ---------------------------------------------------------------------------
// Synchronous API — Z3Verifier class + result types
// ---------------------------------------------------------------------------

/** Result of a synchronous verification run (orchestrator pipeline). */
export interface Z3VerifyResult {
  /** Whether the constraint set is satisfiable (no contradiction found). */
  readonly satisfiable: boolean;
  /** Resource limit steps actually consumed. */
  readonly rlimitUsed: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Resource limit bound that was applied. */
  readonly rlimitBound: number;
}

/** Result of a synchronous sketch synthesis run. */
export interface Z3SynthesizeResult {
  /** Whether synthesis succeeded and produced assignments for all holes. */
  readonly success: boolean;
  /** Hole-ID → value pairs (entries array for `new Map(…)` construction). */
  readonly assignments: readonly (readonly [string, string])[];
}

/**
 * Synchronous lightweight Z3 verifier used by the orchestrator pipeline.
 *
 * Performs effect-set comparison against contract allowed/prohibited lists
 * without invoking the WASM solver.  For full SMT solving with rlimit,
 * use the async {@link verifyMutation} function instead.
 */
export class Z3Verifier {
  private readonly _verifyRlimit: number;
  private readonly _synthesizeRlimit: number;

  constructor(config: { readonly verifyRlimit: number; readonly synthesizeRlimit: number }) {
    this._verifyRlimit = config.verifyRlimit;
    this._synthesizeRlimit = config.synthesizeRlimit;
  }

  /**
   * Synchronously verify a set of SMT-LIB2 assertion strings against
   * the contract's effect constraints.
   *
   * This performs a lightweight effect-set analysis: it parses the
   * assertion strings to detect declared effect kinds, then checks
   * them against the allowed / prohibited lists.  Full Z3 solving is
   * delegated to the async {@link verifyMutation} function.
   *
   * @param assertions  SMT-LIB2 assertion strings from the constraint translator.
   * @param rlimit      Resource limit bound (may differ from the constructor's).
   * @returns           Satisfaction result with timing information.
   */
  verify(assertions: readonly string[], rlimit: number): Z3VerifyResult {
    const start = Date.now();
    const rlimitUsed = Math.min(rlimit, this._verifyRlimit);

    // Lightweight analysis: check if any assertion encodes a prohibited effect.
    const declaredEffects = extractDeclaredEffects(assertions);
    const violatedEffects = detectEffectViolations(declaredEffects, assertions);

    const satisfiable = violatedEffects.length === 0;

    if (!satisfiable) {
      log.info('z3_verifier_sync_violation', {
        violatedEffects,
        assertionCount: assertions.length,
        durationMs: Date.now() - start,
      });
    }

    return {
      satisfiable,
      rlimitUsed,
      durationMs: Date.now() - start,
      rlimitBound: rlimit,
    };
  }

  /**
   * Synchronously attempt sketch-based synthesis.
   *
   * Returns a no-op result; actual synthesis is handled by the sketch
   * assembler in the orchestrator pipeline.
   *
   * @param assertions  SMT-LIB2 assertion strings.
   * @param holeIds     Identifiers of holes to fill.
   * @param rlimit      Resource limit bound.
   * @returns           Synthesis result.
   */
  synthesize(
    assertions: readonly string[],
    holeIds: readonly string[],
    rlimit: number,
  ): Z3SynthesizeResult {
    // Synthesis requires the full async Z3 WASM pipeline; the synchronous
    // stub returns failure so the orchestrator falls back to the sketch
    // assembler.
    return { success: false, assignments: [] };
  }
}

// ---------------------------------------------------------------------------
// Proof-carrying mutation types (async API)
// ---------------------------------------------------------------------------

/**
 * A mutation that carries structural proof obligations for Z3 verification.
 *
 * `declaredEffects` lists the effect kinds the mutation is *declared* to
 * produce.  Pre/post-conditions (as SMT-LIB2 fragments or simple Boolean
 * expressions referencing the effect variables) may further constrain which
 * effects actually fire.
 */
export interface ProofCarryingMutation {
  /** Unique identifier for this mutation (used in memo key and logging). */
  readonly id: string;
  /** Effect kinds this mutation is declared to produce. */
  readonly declaredEffects: readonly EffectKind[];
  /**
   * Numeric resource bounds.  Each entry maps a variable name to an
   * inclusive `[min, max]` range expressed as Z3 `Int` constraints.
   *
   * ```text
   * { "memory_bytes": { min: 0, max: 1048576 } }
   * ```
   */
  readonly resourceBounds?: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
  /**
   * SMT-LIB2-format preconditions.  Each string is parsed by Z3 and
   * asserted as a background constraint.  Effect variables are available
   * as Boolean constants named `effect_<kind>` (e.g. `effect_file_write`).
   */
  readonly preconditions?: readonly string[];
  /**
   * SMT-LIB2-format postconditions (same contract as preconditions).
   */
  readonly postconditions?: readonly string[];
}

// ---------------------------------------------------------------------------
// Async verification result
// ---------------------------------------------------------------------------

/** Result of a Z3 rlimit-bounded async verification run. */
export interface VerificationResult {
  /** `true` when the mutation cannot violate the contract within the rlimit. */
  readonly ok: boolean;
  /** Names of contract constraints the counterexample violates (SAT only). */
  readonly violatedConstraints?: readonly string[] | undefined;
  /** Minimal set of assumptions that together prove UNSAT (UNSAT only). */
  readonly unsatCore?: readonly string[] | undefined;
  /** The rlimit used for this verification run. */
  readonly rlimit: number;
  /** Deterministic memo key = SHA-256(contract ‖ mutation ‖ rlimit). */
  readonly memoKey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default resource limit (10 million).  Deterministic across hosts. */
const DEFAULT_RLIMIT = 10_000_000;

/** Name pattern for an effect variable inside Z3. */
function effectVarName(kind: EffectKind): string {
  return `effect_${kind}`;
}

// ---------------------------------------------------------------------------
// Z3 lazy initialisation (singleton)
// ---------------------------------------------------------------------------

type Z3Bindings = Awaited<ReturnType<typeof import('z3-solver').init>>;

let z3InitPromise: Z3Bindings | undefined;
let z3InitInFlight: Promise<Z3Bindings> | undefined;

/**
 * Lazily initialise the Z3 WASM bindings once per process.  The WASM
 * download + compile happens on the first call; subsequent calls return
 * the cached bindings immediately.
 */
async function getZ3Bindings(): Promise<Z3Bindings> {
  if (z3InitPromise !== undefined) return z3InitPromise;
  if (z3InitInFlight !== undefined) return z3InitInFlight;

  z3InitInFlight = (async () => {
    try {
      const mod = await import('z3-solver');
      const bindings = await mod.init();
      z3InitPromise = bindings;
      return bindings;
    } catch (err) {
      z3InitInFlight = undefined;
      throw err;
    }
  })();

  return z3InitInFlight;
}

// ---------------------------------------------------------------------------
// Memo key
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 memo key from the contract, mutation, and
 * rlimit.  Two calls with identical inputs always produce the same key so
 * that Phase 4 caching can skip re-verification.
 */
export function computeMemoKey(
  contract: AgentContract,
  mutation: ProofCarryingMutation,
  rlimit: number,
): string {
  const payload = JSON.stringify({
    contractId: contract.id,
    allowedEffects: contract.allowedEffects,
    prohibitedEffects: contract.prohibitedEffects,
    inputType: contract.inputType,
    outputType: contract.outputType,
    mutationId: mutation.id,
    declaredEffects: mutation.declaredEffects,
    resourceBounds: mutation.resourceBounds,
    preconditions: mutation.preconditions,
    postconditions: mutation.postconditions,
    rlimit,
  });
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Synchronous helpers (lightweight effect analysis)
// ---------------------------------------------------------------------------

/**
 * Extract declared effect kinds from SMT-LIB2 assertion strings by
 * looking for the `effect_<kind>` naming convention.
 */
function extractDeclaredEffects(assertions: readonly string[]): EffectKind[] {
  const found = new Set<EffectKind>();
  const joined = assertions.join(' ');
  for (const kind of ALL_EFFECT_KINDS) {
    if (joined.includes(effectVarName(kind))) {
      found.add(kind);
    }
  }
  return [...found];
}

/**
 * Detect whether any declared effects violate contract constraints
 * encoded in the assertions.
 */
function detectEffectViolations(
  declaredEffects: EffectKind[],
  assertions: readonly string[],
): EffectKind[] {
  // Simple heuristic: if an effect appears as a positive assertion but is
  // also negated (prohibited), it's a violation.
  const joined = assertions.join(' ');
  const violations: EffectKind[] = [];
  for (const kind of declaredEffects) {
    const positive = joined.includes(effectVarName(kind));
    const negative = joined.includes(`not ${effectVarName(kind)}`) ||
      joined.includes(`(not ${effectVarName(kind)})`);
    if (positive && negative) {
      violations.push(kind);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Z3 async helpers
// ---------------------------------------------------------------------------

/** Minimal type for the Z3 Context we use in async verification. */
interface Z3Ctx {
  Bool: { const(name: string): Z3BoolExpr };
  Int: { const(name: string): Z3ArithExpr };
  Solver: new () => Z3Solver;
  And(...args: unknown[]): Z3BoolExpr;
  Or(...args: unknown[]): Z3BoolExpr;
  Not(a: unknown): Z3BoolExpr;
  LE(a: unknown, b: unknown): Z3BoolExpr;
  GE(a: unknown, b: unknown): Z3BoolExpr;
  ast_from_string(s: string): unknown;
}

/** Minimal solver type. */
interface Z3Solver {
  set(key: string, value: unknown): void;
  add(...exprs: unknown[]): void;
  check(...exprs: unknown[]): Promise<'sat' | 'unsat' | 'unknown'>;
  unsatCore(): Z3AstVector;
  model(): Z3Model;
  reasonUnknown(): string;
  release(): void;
}

/** Minimal Boolean expression type. */
interface Z3BoolExpr {
  not(): Z3BoolExpr;
  sexpr(): string;
}

/** Minimal arithmetic expression type. */
interface Z3ArithExpr {
  // Placeholder — used only for Int.const().
}

/** Minimal ast vector type. */
interface Z3AstVector {
  length(): number;
  get(i: number): { sexpr(): string };
}

/** Minimal model type. */
interface Z3Model {
  get(expr: unknown): unknown;
}

/**
 * Build the list of contract invariant assumptions.
 *
 * Each invariant is a labelled Boolean expression.  When the solver
 * returns UNSAT the unsat-core tells us which of these invariants
 * together make the violation impossible.
 */
function buildContractInvariants(
  contract: AgentContract,
  effectVars: Map<EffectKind, Z3BoolExpr>,
): Array<{ label: string; expr: Z3BoolExpr }> {
  const invariants: Array<{ label: string; expr: Z3BoolExpr }> = [];

  // Prohibited effects must be false.
  for (const prohibited of contract.prohibitedEffects) {
    const v = effectVars.get(prohibited.kind);
    if (v === undefined) continue;
    invariants.push({
      label: `contract.prohibited:${prohibited.kind}`,
      expr: v.not(),
    });
  }

  // When an allowlist exists, every non-listed effect must be false.
  if (contract.allowedEffects.length > 0) {
    const allowedSet = new Set(contract.allowedEffects.map((e) => e.kind));
    for (const kind of ALL_EFFECT_KINDS) {
      if (allowedSet.has(kind)) continue;
      const v = effectVars.get(kind);
      if (v === undefined) continue;
      // Skip if already covered by the prohibited list.
      if (contract.prohibitedEffects.some((p) => p.kind === kind)) continue;
      invariants.push({
        label: `contract.not-allowed:${kind}`,
        expr: v.not(),
      });
    }
  }

  return invariants;
}

/**
 * Build the violation condition: at least one declared mutation effect
 * violates the contract.
 *
 * Returns `undefined` when no declared effect can possibly violate (fast
 * path — no Z3 call needed).
 */
function buildViolationCondition(
  contract: AgentContract,
  declaredEffects: readonly EffectKind[],
): EffectKind[] | undefined {
  const violated: EffectKind[] = [];
  const allowedSet = new Set(contract.allowedEffects.map((e) => e.kind));
  const prohibitedSet = new Set(contract.prohibitedEffects.map((e) => e.kind));

  for (const kind of declaredEffects) {
    if (prohibitedSet.has(kind)) {
      violated.push(kind);
    } else if (contract.allowedEffects.length > 0 && !allowedSet.has(kind)) {
      violated.push(kind);
    }
  }

  return violated.length > 0 ? violated : undefined;
}

/**
 * After a SAT result, extract which contract constraints are violated
 * according to the witness model.
 */
function extractViolatedConstraints(
  model: Z3Model,
  contract: AgentContract,
  effectVars: Map<EffectKind, Z3BoolExpr>,
): string[] {
  const violated: string[] = [];
  const allowedSet = new Set(contract.allowedEffects.map((e) => e.kind));

  for (const kind of ALL_EFFECT_KINDS) {
    const v = effectVars.get(kind);
    if (v === undefined) continue;

    // Check if the model assigns `true` to this effect.
    const val = model.get(v);
    const isTrue = val === true ||
      (typeof val === 'object' && val !== null && 'sexpr' in val &&
        (val as { sexpr(): string }).sexpr() === 'true');

    if (!isTrue) continue;

    // Effect is true in the model — does it violate the contract?
    if (contract.prohibitedEffects.some((p) => p.kind === kind)) {
      violated.push(`contract.prohibited:${kind}`);
    } else if (contract.allowedEffects.length > 0 && !allowedSet.has(kind)) {
      violated.push(`contract.not-allowed:${kind}`);
    }
  }

  return violated;
}

// ---------------------------------------------------------------------------
// Async verification entry point
// ---------------------------------------------------------------------------

/**
 * Verify that a proof-carrying mutation satisfies an agent contract using
 * Z3 with a deterministic resource limit.
 *
 * @param contract  The agent contract whose invariants must hold.
 * @param mutation  The mutation to verify against the contract.
 * @param rlimit    Resource limit (default 10 000 000).  NO wall-clock
 *                  timeout — all determinism comes from rlimit.
 * @returns         A `VerificationResult` with `ok: true` when the
 *                  mutation cannot violate the contract within the rlimit.
 */
export async function verifyMutation(
  contract: AgentContract,
  mutation: ProofCarryingMutation,
  rlimit: number = DEFAULT_RLIMIT,
): Promise<VerificationResult> {
  const memoKey = computeMemoKey(contract, mutation, rlimit);
  const startTime = Date.now();

  // ------------------------------------------------------------------
  // Fast path: trivially safe or trivially violated.
  // ------------------------------------------------------------------
  const trivialViolation = buildViolationCondition(contract, mutation.declaredEffects);

  if (trivialViolation === undefined) {
    // No declared effect can violate the contract — no Z3 call needed.
    log.debug('z3_verifier_trivial_ok', {
      contractId: contract.id,
      mutationId: mutation.id,
      rlimit,
      durationMs: Date.now() - startTime,
    });
    return { ok: true, rlimit, memoKey };
  }

  // ------------------------------------------------------------------
  // Initialise Z3 and create a fresh context + solver.
  // ------------------------------------------------------------------
  const { Context: Z3Context } = await getZ3Bindings();
  const ctx = new (Z3Context as unknown as new (name: string) => Z3Ctx)(`z3v-${mutation.id}`);
  const solver = new ctx.Solver();

  try {
    // Set rlimit (deterministic resource bound — NO wall-clock timeout).
    solver.set('rlimit', rlimit);

    // ----------------------------------------------------------------
    // Create effect Boolean variables.
    // ----------------------------------------------------------------
    const effectVars = new Map<EffectKind, Z3BoolExpr>();
    for (const kind of ALL_EFFECT_KINDS) {
      effectVars.set(kind, ctx.Bool.const(effectVarName(kind)));
    }

    // ----------------------------------------------------------------
    // Assert mutation effects (permanent assertions).
    // ----------------------------------------------------------------
    for (const kind of mutation.declaredEffects) {
      const v = effectVars.get(kind);
      if (v !== undefined) {
        solver.add(v);
      }
    }

    // ----------------------------------------------------------------
    // Assert resource bounds.
    // ----------------------------------------------------------------
    if (mutation.resourceBounds !== undefined) {
      for (const [varName, bounds] of Object.entries(mutation.resourceBounds)) {
        const z3Var = ctx.Int.const(`resource_${varName}`);
        solver.add(ctx.LE(z3Var, bounds.max));
        solver.add(ctx.GE(z3Var, bounds.min));
      }
    }

    // ----------------------------------------------------------------
    // Assert SMT-LIB2 preconditions / postconditions.
    // ----------------------------------------------------------------
    for (const smt of mutation.preconditions ?? []) {
      try {
        const ast = ctx.ast_from_string(smt);
        solver.add(ast);
      } catch (err) {
        log.warn('z3_verifier_precondition_parse_error', {
          mutationId: mutation.id,
          smt: smt.slice(0, 200),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const smt of mutation.postconditions ?? []) {
      try {
        const ast = ctx.ast_from_string(smt);
        solver.add(ast);
      } catch (err) {
        log.warn('z3_verifier_postcondition_parse_error', {
          mutationId: mutation.id,
          smt: smt.slice(0, 200),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ----------------------------------------------------------------
    // Build contract invariant assumptions + violation assumption.
    // ----------------------------------------------------------------
    const invariants = buildContractInvariants(contract, effectVars);

    // The violation assumption: at least one declared effect violates.
    const violationExprs = trivialViolation.map((kind) => effectVars.get(kind)!);
    const violationAssumption =
      violationExprs.length === 1
        ? violationExprs[0]
        : ctx.Or(...violationExprs);

    // All assumptions: contract invariants ∪ violation condition.
    const assumptions = [...invariants.map((inv) => inv.expr), violationAssumption];

    // ----------------------------------------------------------------
    // Check with assumptions — unsatCore works on these.
    // ----------------------------------------------------------------
    const result = await solver.check(...assumptions);

    if (result === 'unsat') {
      // The violation is impossible within the rlimit.
      let unsatCore: string[] | undefined;
      try {
        const core = solver.unsatCore();
        const coreSize = core.length();
        const names: string[] = [];
        for (let i = 0; i < coreSize; i++) {
          names.push(core.get(i).sexpr());
        }
        unsatCore = names.length > 0 ? names : undefined;
      } catch {
        // unsatCore() may fail if no assumptions were tracked; that's OK.
      }

      log.debug('z3_verifier_unsat', {
        contractId: contract.id,
        mutationId: mutation.id,
        rlimit,
        coreSize: unsatCore?.length ?? 0,
        durationMs: Date.now() - startTime,
      });

      return { ok: true, unsatCore, rlimit, memoKey };
    }

    if (result === 'sat') {
      // A counterexample exists — extract violated constraints from the model.
      const model = solver.model();
      const violatedConstraints = extractViolatedConstraints(model, contract, effectVars);

      log.info('z3_verifier_sat_violation', {
        contractId: contract.id,
        mutationId: mutation.id,
        rlimit,
        violatedCount: violatedConstraints.length,
        durationMs: Date.now() - startTime,
      });

      return {
        ok: false,
        violatedConstraints: violatedConstraints.length > 0
          ? violatedConstraints
          : [`contract.violation:${trivialViolation.join(',')}`],
        rlimit,
        memoKey,
      };
    }

    // unknown — rlimit exhausted or solver gave up.
    log.warn('z3_verifier_unknown', {
      contractId: contract.id,
      mutationId: mutation.id,
      rlimit,
      reason: solver.reasonUnknown(),
      durationMs: Date.now() - startTime,
    });

    return {
      ok: false,
      violatedConstraints: ['z3.result:unknown'],
      rlimit,
      memoKey,
    };
  } finally {
    solver.release();
  }
}
