/**
 * Z3 MBQI-based deterministic synthesis engine.
 *
 * Maps sketch holes to Z3 sorts, converts SMT-LIB2 constraints to Z3
 * assertions, and extracts satisfying assignments from the model.
 *
 * **Determinism guarantee**: every call sets the Z3 global `rlimit`
 * parameter before `solver.check()`, bounding resource consumption
 * so results are reproducible within the same budget.
 *
 * @module
 */

import type {
  SynthesisHole,
  SynthesisSketch,
  ValueDomain,
} from '#/tools/synthesis/synthesis-input';
import type { Z3HighLevel, Z3LowLevel } from 'z3-solver';

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/** Outcome of a single synthesis pass. */
export interface SynthesisResult {
  /** `true` when all constraints were satisfiable within the rlimit. */
  readonly success: boolean;

  /** Hole ID → synthesized value (only present on success). */
  readonly holeValues?: Map<string, string>;

  /** Z3 model description string (only present on success). */
  readonly model?: string;

  /** The rlimit value that was used. */
  readonly rlimit: number;

  /**
   * Deterministic cache key composed of sketch ID + rlimit.
   * Phase 4 memoization uses this to skip redundant synthesis.
   */
  readonly memoKey: string;

  /** Human-readable error when synthesis fails (UNSAT or Z3 error). */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default resource limit for deterministic Z3 solving. */
const DEFAULT_RLIMIT = 1_000_000;

// ---------------------------------------------------------------------------
// Lazy Z3 initialisation
// ---------------------------------------------------------------------------

/**
 * Cached init promise.  The WASM module (~34 MB) is loaded once and reused
 * across all synthesis calls in the process.
 */
let z3InitPromise: Promise<Z3HighLevel & Z3LowLevel> | null = null;

// Minimal type shape for the low-level Z3 core object — avoids pulling in
// the full generated type definitions at the call-site level.

interface Z3Core {
  readonly global_param_set: (key: string, value: string) => void;
  readonly mk_config: () => unknown;
  readonly mk_context_rc: (cfg: unknown) => unknown;
  readonly del_config: (cfg: unknown) => void;
  readonly mk_solver: (ctx: unknown) => unknown;
  readonly solver_assert: (ctx: unknown, solver: unknown, ast: unknown) => void;
  readonly solver_check: (ctx: unknown, solver: unknown) => Promise<number>;
  readonly solver_get_model: (ctx: unknown, solver: unknown) => unknown;
  readonly parse_smtlib2_string: (
    ctx: unknown,
    str: string,
    sorts: unknown[],
    sortNames: unknown[],
    decls: unknown[],
    defs: unknown[],
  ) => unknown;
  readonly ast_vector_size: (ctx: unknown, vec: unknown) => number;
  readonly ast_vector_get: (ctx: unknown, vec: unknown, i: number) => unknown;
  readonly model_get_num_consts: (ctx: unknown, model: unknown) => number;
  readonly model_get_const_decl: (ctx: unknown, model: unknown, i: number) => unknown;
  readonly model_get_const_interp: (ctx: unknown, model: unknown, decl: unknown) => unknown | null;
  readonly get_decl_name: (ctx: unknown, decl: unknown) => unknown;
  readonly get_symbol_string: (ctx: unknown, sym: unknown) => string;
  readonly ast_to_string: (ctx: unknown, ast: unknown) => string;
}

/** `solver_check` return values mapped to `Z3_lbool`. */
const Z3_L_TRUE = 1; // SAT

async function ensureZ3() {
  if (!z3InitPromise) {
    z3InitPromise = (async () => {
      // Dynamic import keeps the WASM module out of the cold path.
      const { init } = await import('z3-solver');
      return init();
    })();
  }
  return z3InitPromise;
}

// ---------------------------------------------------------------------------
// SMT-LIB2 program builder
// ---------------------------------------------------------------------------

/**
 * Build a complete SMT-LIB2 program string from a synthesis sketch.
 *
 * Each hole is declared as a `(declare-const <id> <Sort>)`.  User-supplied
 * constraints are emitted verbatim as `(assert <body>)`.  Domain metadata
 * generates implicit boundary constraints (e.g. `'pos_int'` → `> 0`).
 */
function buildSMTLIB2(sketch: SynthesisSketch): string {
  const lines: string[] = [];

  for (const hole of sketch.holes) {
    lines.push(`(declare-const ${hole.id} ${domainToSortName(hole.domain)})`);

    // Domain-meta implicit boundary constraints
    if (hole.domainMeta !== undefined) {
      const metaBounds = domainMetaToConstraints(hole);
      lines.push(...metaBounds);
    }
  }

  // User-supplied constraints (SMT-LIB2 assertion bodies)
  for (const c of sketch.constraints) {
    lines.push(`(assert ${c.body})`);
  }

  // MBQI template hints (search-space narrowing)
  if (sketch.templateHints) {
    for (const hint of sketch.templateHints) {
      lines.push(`(assert ${hint.pattern})`);
    }
  }

  return lines.join('\n');
}

function domainToSortName(domain: ValueDomain): string {
  switch (domain) {
    case 'int':
      return 'Int';
    case 'float':
      return 'Real';
    case 'bool':
      return 'Bool';
    case 'string':
      return 'String';
  }
}

/**
 * Translate `domainMeta` strings into SMT-LIB2 constraint lines.
 *
 * Supported meta values:
 * - `'pos_int'`  → `(assert (> hole 0))`
 * - `'neg_int'`  → `(assert (< hole 0))`
 * - `'nonneg'`   → `(assert (>= hole 0))`
 * - `'len_min_1'` → `(assert (>= (str.len hole) 1))`
 */
function domainMetaToConstraints(hole: SynthesisHole): string[] {
  const lines: string[] = [];
  switch (hole.domainMeta) {
    case 'pos_int':
      lines.push(`(assert (> ${hole.id} 0))`);
      break;
    case 'neg_int':
      lines.push(`(assert (< ${hole.id} 0))`);
      break;
    case 'nonneg':
      lines.push(`(assert (>= ${hole.id} 0))`);
      break;
    case 'len_min_1':
      lines.push(`(assert (>= (str.len ${hole.id}) 1))`);
      break;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Memo key
// ---------------------------------------------------------------------------

function buildMemoKey(sketchId: string, rlimit: number): string {
  return `${sketchId}:rlimit=${rlimit}`;
}

// ---------------------------------------------------------------------------
// Model value extraction
// ---------------------------------------------------------------------------

/**
 * Iterate over the model's constant declarations and extract values for
 * each hole in the sketch.  Uses `model_get_const_interp` +
 * `ast_to_string` to get human-readable representations.
 */
function extractHoleValues(
  z3: Z3Core,
  ctx: unknown,
  model: unknown,
  sketch: SynthesisSketch,
): Map<string, string> {
  const values = new Map<string, string>();
  const holeIds = new Set(sketch.holes.map(h => h.id));

  const numConsts = z3.model_get_num_consts(ctx, model);
  for (let i = 0; i < numConsts; i++) {
    const decl = z3.model_get_const_decl(ctx, model, i);
    const nameSym = z3.get_decl_name(ctx, decl);
    const name = z3.get_symbol_string(ctx, nameSym);

    if (!holeIds.has(name)) continue;

    const interp = z3.model_get_const_interp(ctx, model, decl);
    if (interp !== null) {
      values.set(name, z3.ast_to_string(ctx, interp));
    }
  }

  return values;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesize concrete values for every hole in a sketch using Z3's
 * MBQI-based SMT solver.
 *
 * The function is deterministic within the given `rlimit` budget:
 * the same sketch + rlimit always produces the same memoKey, and
 * Z3's rlimit-bounded search yields reproducible results.
 *
 * @param sketch  - The synthesis sketch to solve.
 * @param rlimit  - Z3 resource limit (default {@link DEFAULT_RLIMIT}).
 * @returns       - {@link SynthesisResult} with hole values on SAT,
 *                  or an error describing the UNSAT / failure reason.
 */
export async function synthesizeHoles(
  sketch: SynthesisSketch,
  rlimit?: number,
): Promise<SynthesisResult> {
  const effectiveRlimit = rlimit ?? DEFAULT_RLIMIT;
  const memoKey = buildMemoKey(sketch.id, effectiveRlimit);

  // Trivial sketch — no holes to solve.
  if (sketch.holes.length === 0) {
    return {
      success: true,
      holeValues: new Map(),
      rlimit: effectiveRlimit,
      memoKey,
    };
  }

  try {
    const { Z3: z3, setParam } = (await ensureZ3()) as { Z3: Z3Core; setParam: (key: string, value: string) => void };

    // ── Deterministic rlimit ────────────────────────────────────────
    // Setting the global `rlimit` parameter bounds Z3's resource
    // consumption.  With a fixed budget the search is deterministic
    // for the same input, enabling safe memoization.
    setParam('rlimit', String(effectiveRlimit));

    // ── Create context ──────────────────────────────────────────────
    const cfg = z3.mk_config();
    const ctx = z3.mk_context_rc(cfg);
    z3.del_config(cfg);

    // ── Build & parse SMT-LIB2 ─────────────────────────────────────
    const smtlib = buildSMTLIB2(sketch);
    const astVec = z3.parse_smtlib2_string(ctx, smtlib, [], [], [], []);

    // ── Create solver & add assertions ──────────────────────────────
    const solver = z3.mk_solver(ctx);
    const count = z3.ast_vector_size(ctx, astVec);
    for (let i = 0; i < count; i++) {
      const ast = z3.ast_vector_get(ctx, astVec, i);
      z3.solver_assert(ctx, solver, ast);
    }

    // ── Check satisfiability (async — runs on worker thread) ────────
    const lbool = await z3.solver_check(ctx, solver);

    if (lbool === Z3_L_TRUE) {
      // ── SAT — extract model values ──────────────────────────────
      const model = z3.solver_get_model(ctx, solver);
      const holeValues = extractHoleValues(z3, ctx, model, sketch);
      const modelStr = z3.ast_to_string(ctx, model);

      return {
        success: true,
        holeValues,
        model: modelStr,
        rlimit: effectiveRlimit,
        memoKey,
      };
    }

    // ── UNSAT — specification is contradictory ────────────────────
    return {
      success: false,
      rlimit: effectiveRlimit,
      memoKey,
      error:
        `UNSAT: sketch '${sketch.id}' has contradictory constraints — ` +
        `no valid assignment exists for ${sketch.holes.length} hole(s). ` +
        `Revise the specification to resolve the contradiction.`,
    };
  } catch (err: unknown) {
    // ── Z3 runtime error (WASM crash, init failure, etc.) ──────────
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      rlimit: effectiveRlimit,
      memoKey: buildMemoKey(sketch.id, effectiveRlimit),
      error: `Z3 synthesis error: ${message}`,
    };
  }
}
