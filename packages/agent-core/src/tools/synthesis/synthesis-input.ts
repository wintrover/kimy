/**
 * Z3 Synthesis Input Types for AgentSwarm Sketch-Based Algebraic Synthesis.
 *
 * These types describe the **synthesis-level** sketch consumed by the Z3
 * synthesizer — distinct from the source-level `Sketch` in `sketch-parser.ts`
 * and the assembly-level `Sketch` in `sketch-assembler.ts`.
 *
 * The synthesis input maps each unknown sub-expression ("hole") to a Z3
 * domain (`ValueDomain`) and a set of SMT-LIB2 constraint assertions that
 * narrow the solution space.
 */

/**
 * Z3 sort domain for a hole — determines which SMT-LIB2 sort Z3 assigns.
 *
 * - `'string'` → `(declare-const <id> String)`
 * - `'int'`    → `(declare-const <id> Int)`
 * - `'bool'`   → `(declare-const <id> Bool)`
 * - `'float'`  → `(declare-const <id> Real)`
 */
export type ValueDomain = 'string' | 'int' | 'bool' | 'float';

/**
 * A single hole in the synthesis input.
 *
 * - `id`: Stable identifier, matching the SMT-LIB2 constant name.
 * - `domain`: Z3 sort domain, used for `(declare-const ...)`.
 * - `domainMeta`: Optional metadata for finer-grained sort selection
 *   (e.g. `'pos_int'` → `(assert (> hole 0))`).
 * - `description`: Human-readable description of what the hole represents.
 */
export interface SynthesisHole {
  readonly id: string;
  readonly domain: ValueDomain;
  readonly domainMeta?: string;
  readonly description?: string;
}

/**
 * A constraint on the synthesis input.
 *
 * `body` is an SMT-LIB2 expression string (without the `(assert ...)` wrapper)
 * that references hole IDs by name. The synthesizer wraps it in `(assert ...)`.
 *
 * Example body: `"(> retryCount 0)"` → `(assert (> retryCount 0))`
 */
export interface SynthesisConstraint {
  readonly body: string;
}

/**
 * A template hint providing a preferred value pattern for a hole.
 * Used for Z3 MBQI search-space seeding.
 */
export interface TemplateHint {
  readonly pattern: string;
}

/**
 * The synthesis-level sketch consumed by `synthesizeHoles`.
 *
 * This is the Z3 input: holes with their domains, user-defined constraints,
 * and optional template hints. The `buildSMTLIB2` function converts this
 * into a complete SMT-LIB2 program.
 */
export interface SynthesisSketch {
  /** Unique identifier for this synthesis sketch (content-addressed). */
  readonly id: string;
  /** Content-addressed Node ID of the target AST node. */
  readonly targetNode: string;
  /** The source template with holes in situ (for memoKey). */
  readonly template: string;
  /** Holes to synthesise. */
  readonly holes: readonly SynthesisHole[];
  /** SMT-LIB2 assertion-body constraints (wrapped in `(assert ...)`). */
  readonly constraints: readonly SynthesisConstraint[];
  /** Optional template hints for MBQI seeding. */
  readonly templateHints?: readonly TemplateHint[];
}
