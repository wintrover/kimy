/**
 * Specification consistency validator for AgentSwarm Sketch-Based Algebraic Synthesis.
 *
 * Validates internal consistency of agent-generated specifications by encoding
 * preconditions, postconditions, and invariants as propositional logic formulas,
 * then checking satisfiability via a bounded DPLL SAT solver. An unsatisfiable
 * conjunction indicates a contradictory spec.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { log } from '#/logging/logger';

// ---------------------------------------------------------------------------
// Formula AST
// ---------------------------------------------------------------------------

/**
 * Propositional logic formula used to express spec constraints.
 *
 * Every formula reduces to a finite tree of boolean connectives over named
 * variables. Variables are arbitrary string identifiers; the solver treats
 * them as abstract proposition symbols.
 */
export type Formula =
  | FormulaVar
  | FormulaConst
  | FormulaNot
  | FormulaAnd
  | FormulaOr
  | FormulaImplies
  | FormulaIff
  | FormulaXor;

export interface FormulaVar {
  readonly kind: 'var';
  /** Unique variable identifier. */
  readonly name: string;
  /** Human-readable label for diagnostics. */
  readonly label?: string | undefined;
}

export interface FormulaConst {
  readonly kind: 'const';
  readonly value: boolean;
}

export interface FormulaNot {
  readonly kind: 'not';
  readonly inner: Formula;
}

export interface FormulaAnd {
  readonly kind: 'and';
  readonly children: readonly Formula[];
}

export interface FormulaOr {
  readonly kind: 'or';
  readonly children: readonly Formula[];
}

export interface FormulaImplies {
  readonly kind: 'implies';
  readonly left: Formula;
  readonly right: Formula;
}

export interface FormulaIff {
  readonly kind: 'iff';
  readonly left: Formula;
  readonly right: Formula;
}

export interface FormulaXor {
  readonly kind: 'xor';
  readonly left: Formula;
  readonly right: Formula;
}

// ---------------------------------------------------------------------------
// Sketch types
// ---------------------------------------------------------------------------

/**
 * A single named constraint within a Sketch specification.
 */
export interface SketchConstraint {
  /** Unique identifier for this constraint (e.g. "pre:auth-required"). */
  readonly id: string;
  /** The logical formula expressing this constraint. */
  readonly formula: Formula;
  /** Optional human-readable description. */
  readonly description?: string | undefined;
}

/**
 * Sketch — a partially-specified agent behavior specification.
 *
 * A Sketch captures the algebraic contract of an agent: what must hold
 * before execution (preconditions), what is guaranteed after execution
 * (postconditions), and what must remain true throughout (invariants).
 *
 * The spec is **consistent** when the conjunction of all constraints is
 * satisfiable. An unsatisfiable conjunction means the spec is contradictory.
 */
export interface Sketch {
  /** Unique identifier for this specification. */
  readonly id: string;
  /** Conditions that must hold before agent execution. */
  readonly preconditions: readonly SketchConstraint[];
  /** Conditions that must hold after agent execution. */
  readonly postconditions: readonly SketchConstraint[];
  /** Conditions that must hold throughout execution. */
  readonly invariants: readonly SketchConstraint[];
  /** Optional assumptions — facts accepted without proof. */
  readonly assumptions?: readonly SketchConstraint[] | undefined;
  /** Optional ensures — additional guarantee clauses. */
  readonly ensures?: readonly SketchConstraint[] | undefined;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface SpecValidationResult {
  /** Whether the spec constraints are jointly satisfiable. */
  readonly consistent: boolean;
  /** When inconsistent, human-readable contradiction explanations. */
  readonly contradictions?: readonly string[] | undefined;
  /** Number of solver steps consumed (bounded by rlimit). */
  readonly rlimit: number;
  /** Deterministic memoization key derived from the spec content. */
  readonly memoKey: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ValidateSpecOptions {
  /**
   * Resource limit for the SAT solver — maximum number of search-tree nodes
   * explored before the solver gives up. Higher values allow deeper proofs
   * but take longer. @default 100000
   */
  readonly rlimit?: number | undefined;
  /**
   * Maximum depth for recursive formula simplification before bailing out.
   * Prevents stack overflows on adversarially deep formulas. @default 256
   */
  readonly maxDepth?: number | undefined;
}

// ---------------------------------------------------------------------------
// Default rlimit
// ---------------------------------------------------------------------------

const DEFAULT_RLIMIT = 100_000;
const DEFAULT_MAX_DEPTH = 256;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the internal consistency of an agent-generated Sketch specification.
 *
 * Pipeline:
 * 1. Collect all constraints (preconditions ∧ postconditions ∧ invariants ∧ assumptions ∧ ensures).
 * 2. Convert each constraint's formula to a flat CNF representation.
 * 3. Run a DPLL SAT solver bounded by `rlimit`.
 * 4. UNSAT → spec is contradictory; extract minimal conflict set.
 * 5. SAT → spec is consistent.
 *
 * @param sketch - The specification to validate.
 * @param rlimitOrOptions - Resource limit (number) or full options object.
 * @returns A `SpecValidationResult` indicating consistency.
 */
export function validateSpec(
  sketch: Sketch,
  rlimitOrOptions?: number | ValidateSpecOptions,
): SpecValidationResult {
  const opts = normalizeOptions(rlimitOrOptions);
  const memoKey = computeMemoKey(sketch);

  log.debug('spec_validator_start', {
    sketchId: sketch.id,
    constraintCount: totalConstraintCount(sketch),
    rlimit: opts.rlimit,
    memoKey,
  });

  try {
    return validateSpecInternal(sketch, opts, memoKey);
  } catch (err) {
    log.warn('spec_validator_error', {
      sketchId: sketch.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      consistent: false,
      contradictions: [
        `Validation failed with internal error: ${err instanceof Error ? err.message : String(err)}`,
      ],
      rlimit: 0,
      memoKey,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

function validateSpecInternal(
  sketch: Sketch,
  opts: Required<Pick<ValidateSpecOptions, 'rlimit' | 'maxDepth'>>,
  memoKey: string,
): SpecValidationResult {
  const allConstraints = collectConstraints(sketch);
  if (allConstraints.length === 0) {
    return { consistent: true, rlimit: 0, memoKey };
  }

  // Conjoin all constraint formulas into one master formula.
  const conjunction: FormulaAnd = {
    kind: 'and',
    children: allConstraints.map((c) => c.formula),
  };

  // Convert to NNF then to CNF for DPLL.
  const nnf = toNnf(conjunction);
  const cnf = toCnf(nnf, opts.maxDepth);

  // Run DPLL.
  const solver = new DpllSolver(opts.rlimit);
  const sat = solver.solve(cnf);

  if (sat) {
    return { consistent: true, rlimit: solver.stepsUsed, memoKey };
  }

  // UNSAT — extract contradiction explanation.
  const contradictions = extractContradictions(allConstraints, cnf, solver);
  return {
    consistent: false,
    contradictions,
    rlimit: solver.stepsUsed,
    memoKey,
  };
}

function normalizeOptions(
  rlimitOrOptions?: number | ValidateSpecOptions,
): Required<Pick<ValidateSpecOptions, 'rlimit' | 'maxDepth'>> {
  if (typeof rlimitOrOptions === 'number') {
    return { rlimit: rlimitOrOptions, maxDepth: DEFAULT_MAX_DEPTH };
  }
  return {
    rlimit: rlimitOrOptions?.rlimit ?? DEFAULT_RLIMIT,
    maxDepth: rlimitOrOptions?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
}

function collectConstraints(sketch: Sketch): SketchConstraint[] {
  const all: SketchConstraint[] = [
    ...sketch.preconditions,
    ...sketch.postconditions,
    ...sketch.invariants,
  ];
  if (sketch.assumptions !== undefined) {
    all.push(...sketch.assumptions);
  }
  if (sketch.ensures !== undefined) {
    all.push(...sketch.ensures);
  }
  return all;
}

function totalConstraintCount(sketch: Sketch): number {
  return (
    sketch.preconditions.length +
    sketch.postconditions.length +
    sketch.invariants.length +
    (sketch.assumptions?.length ?? 0) +
    (sketch.ensures?.length ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Memo key
// ---------------------------------------------------------------------------

function computeMemoKey(sketch: Sketch): string {
  const payload = JSON.stringify(sketch, (_key, value) => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Sort object keys for determinism.
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce(
          (sorted: Record<string, unknown>, k) => {
            sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
          },
          {} as Record<string, unknown>,
        );
    }
    return value;
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Formula → NNF conversion
// ---------------------------------------------------------------------------

/** Convert arbitrary formula to Negation Normal Form (NNF). */
function toNnf(formula: Formula): Formula {
  switch (formula.kind) {
    case 'var':
    case 'const':
      return formula;

    case 'not':
      return nnfNot(formula.inner);

    case 'and':
      return { kind: 'and', children: formula.children.map(toNnf) };

    case 'or':
      return { kind: 'or', children: formula.children.map(toNnf) };

    case 'implies':
      // a → b  ≡  ¬a ∨ b
      return toNnf({ kind: 'or', children: [{ kind: 'not', inner: formula.left }, formula.right] });

    case 'iff':
      // a ↔ b  ≡  (a → b) ∧ (b → a)
      return toNnf({
        kind: 'and',
        children: [
          { kind: 'implies', left: formula.left, right: formula.right },
          { kind: 'implies', left: formula.right, right: formula.left },
        ],
      });

    case 'xor':
      // a ⊕ b  ≡  (a ∧ ¬b) ∨ (¬a ∧ b)
      return toNnf({
        kind: 'or',
        children: [
          { kind: 'and', children: [formula.left, { kind: 'not', inner: formula.right }] },
          { kind: 'and', children: [{ kind: 'not', inner: formula.left }, formula.right] },
        ],
      });
  }
}

function nnfNot(formula: Formula): Formula {
  switch (formula.kind) {
    case 'const':
      return { kind: 'const', value: !formula.value };

    case 'not':
      return toNnf(formula.inner);

    case 'var':
      return { kind: 'not', inner: formula };

    case 'and':
      // ¬(a ∧ b) ≡ ¬a ∨ ¬b
      return toNnf({
        kind: 'or',
        children: formula.children.map((c) => ({ kind: 'not', inner: c })),
      });

    case 'or':
      // ¬(a ∨ b) ≡ ¬a ∧ ¬b
      return toNnf({
        kind: 'and',
        children: formula.children.map((c) => ({ kind: 'not', inner: c })),
      });

    case 'implies':
      // ¬(a → b) ≡ a ∧ ¬b
      return toNnf({
        kind: 'and',
        children: [formula.left, { kind: 'not', inner: formula.right }],
      });

    case 'iff':
      // ¬(a ↔ b) ≡ (a ⊕ b) ≡ (a ∧ ¬b) ∨ (¬a ∧ b)
      return toNnf({
        kind: 'or',
        children: [
          { kind: 'and', children: [formula.left, { kind: 'not', inner: formula.right }] },
          { kind: 'and', children: [{ kind: 'not', inner: formula.left }, formula.right] },
        ],
      });

    case 'xor':
      // ¬(a ⊕ b) ≡ a ↔ b
      return toNnf({ kind: 'iff', left: formula.left, right: formula.right });
  }
}

// ---------------------------------------------------------------------------
// NNF → CNF conversion (Tseitin-style, direct)
// ---------------------------------------------------------------------------

/** A literal is either a positive or negated variable. */
type Literal = { readonly polarity: boolean; readonly name: string };

/** A clause is a disjunction of literals. */
type Clause = readonly Literal[];

/** CNF is a conjunction of clauses. */
type CnfFormula = readonly Clause[];

/**
 * Convert an NNF formula to conjunctive normal form.
 *
 * This performs direct structural conversion — no fresh variable introduction
 * needed for propositional formulas. Deep formulas hit the depth limit.
 */
function toCnf(formula: Formula, maxDepth: number): CnfFormula {
  const result = convertToCnf(formula, maxDepth, 0);
  if (result === undefined) {
    // Over depth limit — return tautological CNF (always satisfiable) as a
    // conservative fallback; caller can increase maxDepth.
    return [[]];
  }
  return result;
}

function convertToCnf(formula: Formula, maxDepth: number, depth: number): CnfFormula | undefined {
  if (depth >= maxDepth) return undefined;

  switch (formula.kind) {
    case 'const': {
      // true → empty clause set (tautology); false → single empty clause (unsatisfiable)
      return formula.value ? [] : [[]];
    }

    case 'var':
      return [[{ polarity: true, name: formula.name }]];

    case 'not': {
      if (formula.inner.kind === 'var') {
        return [[{ polarity: false, name: formula.inner.name }]];
      }
      if (formula.inner.kind === 'const') {
        return convertToCnf({ kind: 'const', value: !formula.inner.value }, maxDepth, depth + 1);
      }
      // Should not happen after NNF, but handle defensively.
      return convertToCnf(toNnf(formula), maxDepth, depth + 1);
    }

    case 'and': {
      const clauses: Clause[] = [];
      for (const child of formula.children) {
        const childCnf = convertToCnf(child, maxDepth, depth + 1);
        if (childCnf === undefined) return undefined;
        clauses.push(...childCnf);
      }
      return clauses;
    }

    case 'or': {
      // Distribute ∨ over ∧ (flatten).
      const childCnfs: CnfFormula[] = [];
      for (const child of formula.children) {
        const childCnf = convertToCnf(child, maxDepth, depth + 1);
        if (childCnf === undefined) return undefined;
        childCnfs.push(childCnf);
      }
      return distributeOr(childCnfs);
    }

    default:
      // After NNF conversion, only var/const/not/and/or should remain.
      return undefined;
  }
}

/**
 * Cartesian product of clause sets under disjunction.
 * (C₁ ∧ C₂ ∧ ...) ∨ (D₁ ∧ D₂ ∧ ...) → all combinations where one
 * clause is picked from each group, then joined.
 *
 * More precisely, for CNF groups G₁, G₂, ..., Gₙ:
 * Each result clause picks one clause from each group and unions their literals.
 */
function distributeOr(groups: readonly CnfFormula[]): CnfFormula {
  if (groups.length === 0) return [[]];
  if (groups.length === 1) return groups[0]!;

  let result: readonly Clause[] = groups[0]!;

  for (let i = 1; i < groups.length; i++) {
    const next = groups[i]!;
    const merged: Clause[] = [];
    for (const leftClause of result) {
      for (const rightClause of next) {
        merged.push([...leftClause, ...rightClause] as Clause);
      }
    }
    result = merged;
  }

  return result;
}

// ---------------------------------------------------------------------------
// DPLL SAT Solver
// ---------------------------------------------------------------------------

class DpllSolver {
  private readonly _rlimit: number;
  private _steps = 0;

  constructor(rlimit: number) {
    this._rlimit = rlimit;
  }

  get stepsUsed(): number {
    return this._steps;
  }

  solve(cnf: CnfFormula): boolean {
    if (cnf.length === 0) return true;
    return this.dpll(cnf, new Map<string, boolean>());
  }

  private dpll(clauses: CnfFormula, assignment: Map<string, boolean>): boolean {
    this._steps++;
    if (this._steps > this._rlimit) {
      // Resource limit hit — conservatively report unsatisfiable to avoid
      // false consistency on undersized budgets.
      return false;
    }

    // Unit propagation.
    const simplified = this.unitPropagate(clauses, assignment);
    if (simplified === undefined) {
      // Empty clause found → contradiction under current assignment.
      return false;
    }
    if (simplified.length === 0) {
      // All clauses satisfied.
      return true;
    }

    // Pure literal elimination.
    const afterPure = this.pureLiteralEliminate(simplified, assignment);
    if (afterPure.length === 0) return true;

    // Pick an unassigned variable and branch.
    const pick = this.pickVariable(afterPure, assignment);
    if (pick === undefined) {
      // All variables assigned but clauses remain → unsatisfiable.
      return false;
    }

    // Try true.
    const withTrue = new Map(assignment);
    withTrue.set(pick, true);
    if (this.dpll(afterPure, withTrue)) return true;

    // Try false.
    const withFalse = new Map(assignment);
    withFalse.set(pick, false);
    return this.dpll(afterPure, withFalse);
  }

  /**
   * Unit propagation: repeatedly find unit clauses (single literal) and
   * force their polarity. Returns simplified CNF or `undefined` on conflict.
   */
  private unitPropagate(
    clauses: CnfFormula,
    assignment: Map<string, boolean>,
  ): CnfFormula | undefined {
    let current: CnfFormula = clauses;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let foundUnit = false;
      let next: Clause[] = [];

      for (const clause of current) {
        const filtered = clause.filter(
          (lit) => assignment.get(lit.name) !== (lit.polarity ? false : true),
        );

        if (filtered.length === 0) {
          // All literals falsified → empty clause → conflict.
          return undefined;
        }

        if (filtered.length === 1) {
          const unitLit = filtered[0]!;
          if (assignment.has(unitLit.name)) {
            // Already assigned — if clause is satisfied, skip; otherwise conflict.
            if (assignment.get(unitLit.name) !== unitLit.polarity) return undefined;
            continue;
          }
          assignment.set(unitLit.name, unitLit.polarity);
          foundUnit = true;
        }

        next.push(filtered);
      }

      current = next;
      if (!foundUnit) break;
    }
    return current;
  }

  /**
   * Pure literal elimination: if a variable appears with only one polarity
   * across all clauses, assign it to satisfy those clauses.
   */
  private pureLiteralEliminate(
    clauses: CnfFormula,
    assignment: Map<string, boolean>,
  ): CnfFormula {
    const polarityCount = new Map<string, { pos: number; neg: number }>();
    for (const clause of clauses) {
      for (const lit of clause) {
        const existing = polarityCount.get(lit.name) ?? { pos: 0, neg: 0 };
        if (lit.polarity) {
          existing.pos++;
        } else {
          existing.neg++;
        }
        polarityCount.set(lit.name, existing);
      }
    }

    const pureLiterals: Literal[] = [];
    for (const [name, counts] of polarityCount) {
      if (assignment.has(name)) continue;
      if (counts.pos > 0 && counts.neg === 0) {
        pureLiterals.push({ polarity: true, name });
      } else if (counts.neg > 0 && counts.pos === 0) {
        pureLiterals.push({ polarity: false, name });
      }
    }

    if (pureLiterals.length === 0) return clauses;

    for (const lit of pureLiterals) {
      assignment.set(lit.name, lit.polarity);
    }

    // Remove clauses satisfied by pure literals (where at least one literal is true).
    return clauses.filter((clause) =>
      clause.every((lit) => assignment.get(lit.name) !== lit.polarity),
    );
  }

  /** Pick the first unassigned variable from the remaining clauses. */
  private pickVariable(clauses: CnfFormula, assignment: Map<string, boolean>): string | undefined {
    for (const clause of clauses) {
      for (const lit of clause) {
        if (!assignment.has(lit.name)) return lit.name;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Contradiction explanation
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a human-readable explanation for why the spec is
 * contradictory. Uses pairwise conflict detection: try removing each
 * constraint and re-checking; constraints whose removal restores
 * satisfiability are part of the core conflict.
 */
function extractContradictions(
  allConstraints: readonly SketchConstraint[],
  fullCnf: CnfFormula,
  solver: DpllSolver,
): string[] {
  // Quick heuristic: report the full set as the conflict set, then try to
  // narrow down via pairwise analysis if the constraint count is small.
  if (allConstraints.length <= 1) {
    return [
      `Single constraint "${allConstraints[0]?.id ?? 'unknown'}" is self-contradictory.`,
    ];
  }

  // For larger sets, do pairwise conflict extraction (quadratic but bounded
  // by spec size which is typically small).
  if (allConstraints.length <= 20) {
    const coreConstraints = findMinimalConflictCore(allConstraints);
    if (coreConstraints.length > 0) {
      return coreConstraints.map(
        (c) =>
          `Constraint "${c.id}" ${c.description !== undefined ? `(${c.description})` : ''} is part of a contradictory set.`,
      );
    }
  }

  // Fallback: report the constraint categories that conflict.
  const categories = categorizeConstraints(allConstraints);
  return [
    `The conjunction of ${categories.join(' ∧ ')} is unsatisfiable — ` +
      `the ${allConstraints.length} constraints cannot all hold simultaneously.`,
  ];
}

/**
 * Attempt to find a minimal conflict core by checking individual constraints.
 * A constraint is in the core if removing it restores satisfiability.
 */
function findMinimalConflictCore(
  allConstraints: readonly SketchConstraint[],
): SketchConstraint[] {
  const core: SketchConstraint[] = [];

  for (let i = 0; i < allConstraints.length; i++) {
    const remaining = [...allConstraints.slice(0, i), ...allConstraints.slice(i + 1)];
    if (remaining.length === 0) continue;

    const conjunction: FormulaAnd = {
      kind: 'and',
      children: remaining.map((c) => c.formula),
    };
    const nnf = toNnf(conjunction);
    const cnf = toCnf(nnf, DEFAULT_MAX_DEPTH);

    const probeSolver = new DpllSolver(Math.min(DEFAULT_RLIMIT, 10_000));
    const sat = probeSolver.solve(cnf);

    if (sat) {
      // Removing this constraint restored satisfiability — it's in the core.
      core.push(allConstraints[i]!);
    }
  }

  return core;
}

function categorizeConstraints(constraints: readonly SketchConstraint[]): string[] {
  const categories = new Set<string>();
  for (const c of constraints) {
    if (c.id.startsWith('pre:')) categories.add('preconditions');
    else if (c.id.startsWith('post:')) categories.add('postconditions');
    else if (c.id.startsWith('inv:')) categories.add('invariants');
    else if (c.id.startsWith('assume:')) categories.add('assumptions');
    else if (c.id.startsWith('ensure:')) categories.add('ensures');
    else categories.add('constraints');
  }
  return [...categories];
}

// ---------------------------------------------------------------------------
// Convenience constructors for formulas
// ---------------------------------------------------------------------------

/** Create a propositional variable. */
export function var_(name: string, label?: string): FormulaVar {
  return { kind: 'var', name, label };
}

/** Create a constant. */
export function const_(value: boolean): FormulaConst {
  return { kind: 'const', value };
}

/** Create a negation. */
export function not(inner: Formula): FormulaNot {
  return { kind: 'not', inner };
}

/** Create a conjunction. */
export function and(...children: Formula[]): FormulaAnd {
  return { kind: 'and', children };
}

/** Create a disjunction. */
export function or(...children: Formula[]): FormulaOr {
  return { kind: 'or', children };
}

/** Create an implication. */
export function implies(left: Formula, right: Formula): FormulaImplies {
  return { kind: 'implies', left, right };
}

/** Create a biconditional. */
export function iff(left: Formula, right: Formula): FormulaIff {
  return { kind: 'iff', left, right };
}

/** Create an exclusive-or. */
export function xor(left: Formula, right: Formula): FormulaXor {
  return { kind: 'xor', left, right };
}
