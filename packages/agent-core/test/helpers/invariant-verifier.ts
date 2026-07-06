/**
 * Z3 SMT-solver–based invariant verification framework.
 *
 * Declares named invariants as Z3 constraints, then checks whether a
 * concrete state satisfies all of them.  Can also verify that a state
 * transition preserves a set of invariants.
 *
 * Follows the same isolated-context pattern as `z3-fixture-generator`:
 * every call creates a fresh Z3 WASM context with no shared state.
 *
 * Uses the Z3 programmatic API exclusively — `ast_from_string` is
 * non-functional in z3-solver v4.16.0 (returns empty ast-vectors).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Description of a single named invariant. */
export interface Invariant {
  /** Human-readable identifier, e.g. `"INV-1"`. */
  id: string;
  /**
   * Build the Z3 assertion AST for this invariant.
   *
   * Receives a map of variable name → Z3 constant object.  Must
   * return a Z3 boolean expression that represents the invariant
   * condition.
   */
  build: (vars: Record<string, unknown>) => unknown;
  /** Optional human-readable description for violation messages. */
  description?: string;
}

/** Outcome of a single invariant check. */
export interface InvariantCheckResult {
  /** `true` when every declared invariant was satisfied. */
  satisfied: boolean;
  /** List of invariant IDs whose assertions were violated. */
  violations: string[];
}

/** A state snapshot expressed as variable declarations + value bindings. */
export interface StateDescriptor {
  /**
   * Map from variable name → Z3 sort domain.
   *
   * @example new Map([['phase', 'string'], ['hasParams', 'bool']])
   */
  variables: Map<string, 'string' | 'int' | 'bool'>;
  /**
   * Map from variable name → concrete value (string representation).
   *
   * @example new Map([['phase', '"planning"'], ['hasParams', 'false']])
   */
  values: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Semantic Invariant Filter
// ---------------------------------------------------------------------------

/**
 * Typed runtime guard that validates an arbitrary input against a
 * schema-like contract.
 *
 * Use this to build a **Semantic Invariant Filter** — a guard that
 * sits at an API boundary and rejects inputs that would violate
 * domain invariants *before* they enter the system.
 *
 * @typeParam T  The narrowed type produced on success.
 */
export interface InvariantGuard<T> {
  /**
   * Validate the input.
   *
   * @returns A discriminated union — either the narrowed data or a
   *          human-readable reason explaining the rejection.
   */
  validate(input: unknown):
    | { valid: true; data: T }
    | { valid: false; reason: string };
}

// ---------------------------------------------------------------------------
// AgentPhase state model (Z3 variables + default invariants)
// ---------------------------------------------------------------------------

/**
 * Z3 variable declarations that model the AgentPhase state.
 *
 * `phase` is an integer encoding of the `AgentPhaseState` enum so Z3
 * can reason about it with simple integer constraints:
 *
 *   - `0` → `"planning"`
 *   - `1` → `"execution"`
 *
 * `hasSwarmParams` is a boolean mirroring `pendingSwarmParams !== null`.
 */
export const AGENT_PHASE_VARS: Map<string, 'string' | 'int' | 'bool'> =
  new Map([
    ['phase', 'int'],
    ['hasSwarmParams', 'bool'],
  ]);

/**
 * Helper to build an integer equality constraint via the programmatic API.
 */
function intEq(z3Var: unknown, value: number, ctx: Z3Ctx): unknown {
  return ctx.Eq(z3Var, ctx.Int.val(value));
}

/**
 * Helper to build a boolean equality constraint via the programmatic API.
 */
function boolEq(z3Var: unknown, value: boolean, ctx: Z3Ctx): unknown {
  return ctx.Eq(z3Var, ctx.Bool.val(value));
}

/**
 * Default AgentPhase invariants built via the Z3 programmatic API.
 *
 * - **INV-1**: `phase ∈ {0, 1}` (i.e. ∈ {planning, execution})
 * - **INV-2**: `phase = 1 → hasSwarmParams` (execution requires swarm params)
 * - **INV-3**: `phase = 0 → ¬hasSwarmParams` (planning means no swarm params)
 */
export function agentPhaseInvariants(ctx: Z3Ctx): Invariant[] {
  return [
    {
      id: 'INV-1',
      description: 'phase must be planning (0) or execution (1)',
      build(vars) {
        const phase = vars['phase']!;
        return ctx.Or(
          intEq(phase, 0, ctx),
          intEq(phase, 1, ctx),
        );
      },
    },
    {
      id: 'INV-2',
      description: 'execution phase requires pendingSwarmParams',
      build(vars) {
        const phase = vars['phase']!;
        const hasParams = vars['hasSwarmParams']!;
        return ctx.Implies(intEq(phase, 1, ctx), hasParams);
      },
    },
    {
      id: 'INV-3',
      description: 'planning phase must have no pendingSwarmParams',
      build(vars) {
        const phase = vars['phase']!;
        const hasParams = vars['hasSwarmParams']!;
        return ctx.Implies(intEq(phase, 0, ctx), ctx.Not(hasParams));
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default resource limit for deterministic Z3 solving. */
const DEFAULT_RLIMIT = 10_000_000;

// ---------------------------------------------------------------------------
// Internal Z3 types
// ---------------------------------------------------------------------------

interface Z3Ctx {
  Bool: { const(name: string): unknown; val(v: boolean): unknown };
  Int: { const(name: string): unknown; val(v: number): unknown };
  Solver: new () => Z3Solver;
  Eq(a: unknown, b: unknown): unknown;
  And(...args: unknown[]): unknown;
  Or(...args: unknown[]): unknown;
  Not(a: unknown): unknown;
  Implies(a: unknown, b: unknown): unknown;
}

interface Z3Solver {
  set(key: string, value: unknown): void;
  add(...exprs: unknown[]): void;
  check(): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): Z3Model;
  reasonUnknown(): string;
  reset(): void;
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

async function createIsolatedContext(): Promise<{
  ctx: Z3Ctx;
  solver: Z3Solver;
}> {
  const { init } = await import('z3-solver');
  const { Context } = await init();

  const id = contextCounter++;
  const ctx = new (Context as unknown as new (name: string) => Z3Ctx)(
    `invariant-${id}`,
  );
  const solver = new ctx.Solver();

  return { ctx, solver };
}

// ---------------------------------------------------------------------------
// InvariantVerifier
// ---------------------------------------------------------------------------

/**
 * Z3-backed invariant verifier.
 *
 * ```ts
 * const verifier = new InvariantVerifier();
 * verifier.declare(AGENT_PHASE_VARS);
 * verifier.addInvariants(agentPhaseInvariants(ctx));
 * await verifier.init();
 * const result = await verifier.verify(state);
 * ```
 */
export class InvariantVerifier {
  private ctx: Z3Ctx | undefined;
  private invariants: Invariant[] = [];
  private declarations: Map<string, 'string' | 'int' | 'bool'> = new Map();
  private z3Variables: Record<string, unknown> = {};

  /**
   * Initialise the Z3 WASM runtime and create an isolated context.
   *
   * Must be called before {@link verify} or {@link verifyTransition}.
   * After calling `init()`, any previously declared variables are
   * materialised as Z3 constant objects in the context.
   */
  async init(): Promise<void> {
    const { ctx } = await createIsolatedContext();
    this.ctx = ctx;

    // Materialise any variables that were declared before init().
    this.materialiseVariables();
  }

  /**
   * Declare the state variables that invariants reason about.
   *
   * Each entry maps a variable name to its Z3 sort domain.  Variables
   * are materialised as Z3 constant objects the first time the
   * context is available (after {@link init}).
   */
  declare(variables: Map<string, 'string' | 'int' | 'bool'>): void {
    for (const [name, domain] of variables) {
      this.declarations.set(name, domain);
    }
    // If already initialised, materialise the new variables now.
    if (this.ctx) {
      this.materialiseVariables();
    }
  }

  /**
   * Register one or more invariants to be verified.
   */
  addInvariants(invariants: Invariant | Invariant[]): void {
    const list = Array.isArray(invariants) ? invariants : [invariants];
    this.invariants.push(...list);
  }

  /**
   * Clear all registered invariants and declarations.
   *
   * Useful when reusing a verifier instance across unrelated checks.
   */
  reset(): void {
    this.invariants = [];
    this.declarations.clear();
    this.z3Variables = {};
  }

  /**
   * Verify that a concrete state satisfies all registered invariants.
   *
   * For each invariant the solver is asked: *"Can the invariant be
   * violated?"*  If the negation is satisfiable the invariant is
   * violated; otherwise it holds.
   */
  async verify(state: StateDescriptor): Promise<InvariantCheckResult> {
    this.ensureInitialised();
    const ctx = this.ctx!;

    const violations: string[] = [];

    for (const inv of this.invariants) {
      const solver = new ctx.Solver();
      solver.set('rlimit', DEFAULT_RLIMIT);

      // Add state value bindings using the programmatic API.
      for (const [name, domain] of state.variables) {
        const val = state.values.get(name);
        if (val === undefined) {
          throw new Error(
            `invariant-verifier: no value for variable '${name}'`,
          );
        }
        const z3Var = this.z3Variables[name];
        solver.add(this.buildEquality(z3Var, domain, val));
      }

      // Assert the *negation* of the invariant.  If UNSAT the
      // invariant holds; if SAT the invariant is violated.
      solver.add(ctx.Not(inv.build(this.z3Variables)));

      const result = await solver.check();
      if (result === 'sat') {
        violations.push(inv.id);
      }

      solver.release();
    }

    return { satisfied: violations.length === 0, violations };
  }

  /**
   * Verify that a state transition preserves all registered invariants.
   *
   * Checks that if the `from` state satisfies the invariants, the `to`
   * state also satisfies them (or that `from` was already violating —
   * this method only catches *new* violations introduced by the
   * transition).
   *
   * @returns The check result for the **target** state, with an
   *          additional `fromSatisfied` flag indicating whether the
   *          source state was valid.
   */
  async verifyTransition(
    from: StateDescriptor,
    to: StateDescriptor,
  ): Promise<InvariantCheckResult & { fromSatisfied: boolean }> {
    const fromResult = await this.verify(from);
    const toResult = await this.verify(to);

    return {
      satisfied: toResult.satisfied,
      violations: toResult.violations,
      fromSatisfied: fromResult.satisfied,
    };
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /**
   * The Z3 context backing this verifier.
   *
   * Exposed so that callers can build Z3 expressions (e.g. via
   * `agentPhaseInvariants`) that share the same sort environment.
   */
  get context(): Z3Ctx | undefined {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureInitialised(): void {
    if (!this.ctx) {
      throw new Error(
        'invariant-verifier: call init() before using the verifier',
      );
    }
  }

  /**
   * Build a Z3 equality constraint binding a variable to a concrete value.
   */
  private buildEquality(
    z3Var: unknown,
    domain: 'string' | 'int' | 'bool',
    val: string,
  ): unknown {
    const ctx = this.ctx!;
    switch (domain) {
      case 'int':
        return ctx.Eq(z3Var, ctx.Int.val(Number(val)));
      case 'bool':
        return ctx.Eq(z3Var, ctx.Bool.val(val === 'true'));
      default:
        throw new Error(
          `invariant-verifier: unsupported domain '${domain}' for equality binding`,
        );
    }
  }

  /**
   * Create Z3 constant objects for all declared variables.
   *
   * These persist in the Z3 context and enable the programmatic API
   * to reference variables by name.
   */
  private materialiseVariables(): void {
    const ctx = this.ctx!;
    for (const [name, domain] of this.declarations) {
      if (!(name in this.z3Variables)) {
        switch (domain) {
          case 'int':
            this.z3Variables[name] = ctx.Int.const(name);
            break;
          case 'bool':
            this.z3Variables[name] = ctx.Bool.const(name);
            break;
          default:
            throw new Error(
              `invariant-verifier: unsupported domain '${domain}'`,
            );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: build a StateDescriptor from plain objects
// ---------------------------------------------------------------------------

/**
 * Helper to build a {@link StateDescriptor} from a plain object and a
 * sort declaration map.
 *
 * @example
 * ```ts
 * const state = agentPhaseState('planning', false);
 * ```
 */
export function agentPhaseState(
  phase: 'planning' | 'execution',
  hasSwarmParams: boolean,
): StateDescriptor {
  const phaseInt = phase === 'planning' ? 0 : 1;
  return {
    variables: new Map(AGENT_PHASE_VARS),
    values: new Map([
      ['phase', String(phaseInt)],
      ['hasSwarmParams', hasSwarmParams ? 'true' : 'false'],
    ]),
  };
}
