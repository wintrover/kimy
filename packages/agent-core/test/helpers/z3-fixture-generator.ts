/**
 * Z3 SAT solver-based fixture generator for deterministic test fixtures.
 *
 * Creates concrete fixture values from structural constraints using
 * Z3's SMT solver.  Each call creates a completely isolated Z3 WASM
 * context — no reuse, no global cache, no `reset()`.
 *
 * ### Determinism guarantee
 *
 * Every call sets a fixed `rlimit` (default 10 000 000) before
 * `solver.check()`, bounding resource consumption so results are
 * reproducible within the same budget.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FixtureConstraint {
  /** Unique name for this constraint — used as the map key in results. */
  name: string;
  /** Z3 sort domain. */
  domain: 'string' | 'int' | 'bool';
  /**
   * SMT-LIB2 assertion bodies (without surrounding `(assert …)`).
   * The variable is named `name`; refer to it directly.
   *
   * @example ['(> x 0)', '(< x 100)']
   */
  constraints: string[];
}

export interface StructuralTemplate {
  /** Template source string containing `??` placeholders for holes. */
  source: string;
  /** Holes to fill — each `??` is replaced in order. */
  holes: Array<{
    /** Identifier used in SMT-LIB2 constraints. */
    id: string;
    /** Z3 sort domain. */
    domain: 'string' | 'int' | 'bool';
    /** SMT-LIB2 assertion bodies referencing `id`. */
    constraints: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default resource limit for deterministic Z3 solving. */
const DEFAULT_RLIMIT = 10_000_000;

// ---------------------------------------------------------------------------
// Internal Z3 types (minimal shape — avoids pulling generated types)
// ---------------------------------------------------------------------------

interface Z3Ctx {
  Bool: { const(name: string): unknown };
  Int: { const(name: string): unknown };
  String: { const(name: string): unknown };
  Solver: new () => Z3Solver;
  And(...args: unknown[]): unknown;
  Or(...args: unknown[]): unknown;
  Not(a: unknown): unknown;
  LE(a: unknown, b: unknown): unknown;
  GE(a: unknown, b: unknown): unknown;
  ast_from_string(s: string): unknown;
}

interface Z3Solver {
  set(key: string, value: unknown): void;
  add(...exprs: unknown[]): void;
  check(...exprs: unknown[]): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): Z3Model;
  reasonUnknown(): string;
  release(): void;
}

interface Z3Model {
  decls(): Array<{ name(): { toString(): string } }>;
  get(expr: unknown): unknown;
}

// ---------------------------------------------------------------------------
// Isolated Z3 context factory
// ---------------------------------------------------------------------------

let contextCounter = 0;

/**
 * Create a completely isolated Z3 WASM context.
 *
 * Each call dynamically imports `z3-solver` and invokes `init()` to
 * obtain fresh bindings, then constructs a new `Context`.  No state
 * is shared between calls.
 */
async function createIsolatedContext(): Promise<{
  ctx: Z3Ctx;
  solver: Z3Solver;
}> {
  const { init } = await import('z3-solver');
  const { Context } = await init();

  const id = contextCounter++;
  const ctx = new (Context as unknown as new (name: string) => Z3Ctx)(`fixture-${id}`);
  const solver = new ctx.Solver();

  return { ctx, solver };
}

// ---------------------------------------------------------------------------
// Domain → Z3 variable + SMT-LIB2 sort mapping
// ---------------------------------------------------------------------------

function createZ3Variable(
  ctx: Z3Ctx,
  name: string,
  domain: 'string' | 'int' | 'bool',
): unknown {
  switch (domain) {
    case 'int':
      return ctx.Int.const(name);
    case 'bool':
      return ctx.Bool.const(name);
    case 'string':
      return ctx.String.const(name);
  }
}

// ---------------------------------------------------------------------------
// Model value extraction
// ---------------------------------------------------------------------------

/**
 * Extract the concrete value of a named variable from a Z3 model.
 *
 * Returns the value as a string suitable for fixture substitution:
 * - `int`  → `"42"`
 * - `bool` → `"true"` / `"false"`
 * - `string` → `"hello"` (Z3 returns quoted strings; we strip quotes)
 */
function extractModelValue(model: Z3Model, name: string): string {
  const decls = model.decls();
  for (const decl of decls) {
    if (decl.name().toString() === name) {
      const val = model.get(decl);
      if (val === undefined || val === null) continue;
      const raw = val.toString();
      // Z3 wraps string values in double-quotes; strip them for fixture use.
      if (raw.startsWith('"') && raw.endsWith('"')) {
        return raw.slice(1, -1);
      }
      return raw;
    }
  }
  throw new Error(`z3-fixture-generator: variable '${name}' not found in model`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate concrete fixture values from Z3 constraints.
 *
 * Each call creates an isolated Z3 context — no reuse.
 *
 * @param constraints  Variable constraints to solve.
 * @param rlimit       Resource limit (default 10 000 000).
 * @returns            Map of constraint name → concrete value string.
 */
export async function generateFixtures(
  constraints: readonly FixtureConstraint[],
  rlimit?: number,
): Promise<Map<string, string>> {
  if (constraints.length === 0) {
    return new Map();
  }

  const { ctx, solver } = await createIsolatedContext();

  try {
    solver.set('rlimit', rlimit ?? DEFAULT_RLIMIT);

    // Declare variables and add constraints.
    const variables = new Map<string, unknown>();
    for (const c of constraints) {
      const z3Var = createZ3Variable(ctx, c.name, c.domain);
      variables.set(c.name, z3Var);

      for (const body of c.constraints) {
        const ast = ctx.ast_from_string(body);
        solver.add(ast);
      }
    }

    // Solve.
    const result = await solver.check();

    if (result === 'sat') {
      const model = solver.model();
      const values = new Map<string, string>();
      for (const name of variables.keys()) {
        values.set(name, extractModelValue(model, name));
      }
      return values;
    }

    if (result === 'unsat') {
      throw new Error(
        `z3-fixture-generator: UNSAT — constraints are contradictory. ` +
        `Variables: [${constraints.map(c => `${c.name}:${c.domain}`).join(', ')}]. ` +
        `Revise constraints to resolve the contradiction.`,
      );
    }

    // unknown
    throw new Error(
      `z3-fixture-generator: UNKNOWN — solver gave up (reason: ${solver.reasonUnknown()}). ` +
      `Variables: [${constraints.map(c => `${c.name}:${c.domain}`).join(', ')}]. ` +
      `Try increasing the rlimit.`,
    );
  } finally {
    solver.release();
  }
}

/**
 * Generate a concrete source string by filling in Z3-determined values
 * for holes in a template.
 *
 * Each `??` in the source template is replaced (left-to-right) with
 * the value generated for the corresponding hole.
 *
 * Each call creates an isolated Z3 context.
 *
 * @param template  Source template with `??` placeholders.
 * @param rlimit    Resource limit (default 10 000 000).
 * @returns         Concrete source string with holes filled.
 */
export async function generateStructuralFixtures(
  template: StructuralTemplate,
  rlimit?: number,
): Promise<string> {
  const constraintList: FixtureConstraint[] = template.holes.map(hole => ({
    name: hole.id,
    domain: hole.domain,
    constraints: hole.constraints,
  }));

  const values = await generateFixtures(constraintList, rlimit);

  let result = template.source;
  for (const hole of template.holes) {
    const value = values.get(hole.id);
    if (value === undefined) {
      throw new Error(
        `z3-fixture-generator: no value generated for hole '${hole.id}'`,
      );
    }
    // Replace the first occurrence of `??` with the concrete value.
    result = result.replace('??', value);
  }

  return result;
}
