/-
  Z3Formula.lean

  Formalization of Z3 SMT formulas in Lean 4 for the AgentSwarm
  deterministic architecture.  Provides:

  * `Z3Formula` – an inductive type modeling core Z3 expressions
    (assertions, Boolean connectives, universal quantification).
  * `Z3Result`  – the three-valued result of an SMT check.
  * `Z3Formula.sound` – a predicate asserting that a formula faithfully
    represents the intended logical constraint.
  * `Z3Formula.captures` – a predicate asserting that a formula
    captures a specific NIF (Nondeterministic-Index-Free) constraint.

  Author : AgentSwarm
  License: MIT
-/

namespace AgentSwarm

-- ============================================================================
-- § 1  Z3Formula
-- ============================================================================

/-- Core Z3 formula type.

    Models a small but sufficient subset of the Z3 SMT-LIB expression
    language used by AgentSwarm's deterministic scheduling pass.

    * `assert prop`     – a named proposition (opaque string).
    * `and lhs rhs`     – logical conjunction.
    * `or  lhs rhs`     – logical disjunction.
    * `not inner`       – logical negation.
    * `forall' vars body` – universal quantification over `vars`.
      (`forall` is a reserved word in Lean 4, hence the trailing prime.) -/
inductive Z3Formula where
  /-- An atomic assertion identified by a human-readable proposition name. -/
  | assert (prop : String)
  /-- Conjunction of two sub-formulas. -/
  | and (lhs rhs : Z3Formula)
  /-- Disjunction of two sub-formulas. -/
  | or (lhs rhs : Z3Formula)
  /-- Negation of a sub-formula. -/
  | not (inner : Z3Formula)
  /-- Universal quantification over a list of variable names. -/
  | forall' (vars : List String) (body : Z3Formula)
  deriving Repr, Inhabited

-- ============================================================================
-- § 2  Z3Result
-- ============================================================================

/-- Result of invoking the Z3 SMT solver on a `Z3Formula`.

    Mirrors the three outcomes of an SMT-LIB `check-sat` call:

    * `sat model`     – satisfiable; `model` is a textual witness.
    * `unsat core`    – unsatisfiable; `core` is a minimal subset of
      assertion names that are jointly contradictory.
    * `unknown`       – Z3 could not determine satisfiability within
      its resource limits. -/
inductive Z3Result where
  | sat (model : String)
  | unsat (core : List String)
  | unknown
  deriving Repr, Inhabited

-- ============================================================================
-- § 3  Soundness
-- ============================================================================

/-- A `Z3Formula` is **sound** if every assertion it contains names a
    proposition that is a valid, well-formed constraint in the target
    domain (here, AgentSwarm scheduling constraints).

    The predicate is parameterised by `validProp : String → Prop`, a
    caller-supplied domain predicate that recognises valid proposition
    names.  A formula is sound when *every* leaf `assert` it contains
    satisfies `validProp`. -/
namespace Z3Formula

/-- Helper: does every assertion leaf in `f` satisfy `P`? -/
def allAssertions (P : String → Prop) : Z3Formula → Prop
  | Z3Formula.assert prop     => P prop
  | Z3Formula.and lhs rhs     => allAssertions P lhs ∧ allAssertions P rhs
  | Z3Formula.or  lhs rhs     => allAssertions P lhs ∧ allAssertions P rhs
  | Z3Formula.not inner        => allAssertions P inner
  | Z3Formula.forall' _ body   => allAssertions P body

/-- Soundness predicate.

    `Z3Formula.sound validProp f` holds iff every atomic assertion in `f`
    passes the domain's validity check `validProp`.  This guarantees that
    the formula, if satisfiable, encodes a meaningful constraint rather
    than an arbitrary or malformed one. -/
def sound (validProp : String → Prop) (f : Z3Formula) : Prop :=
  allAssertions validProp f

-- ============================================================================
-- § 4  NIF Constraint Capture
-- ============================================================================

/-- A formula **captures** a NIF constraint when:

    1. The formula is sound (all assertions are well-formed).
    2. Every variable name in the formula belongs to the supplied
       universe `univ : List String`.
    3. The formula contains at least one assertion leaf. -/
namespace Capture

/-- Collect all variable names that appear under `forall'` binders. -/
def forallVars : Z3Formula → List String
  | Z3Formula.assert _       => []
  | Z3Formula.and lhs rhs     => forallVars lhs ++ forallVars rhs
  | Z3Formula.or  lhs rhs     => forallVars lhs ++ forallVars rhs
  | Z3Formula.not inner        => forallVars inner
  | Z3Formula.forall' vars body => vars ++ forallVars body

/-- Check that every element of `xs` belongs to the universe `univ`. -/
def allInUniv (univ : List String) (xs : List String) : Prop :=
  ∀ x ∈ xs, x ∈ univ

/-- Count the number of assertion leaves. -/
def assertCount : Z3Formula → Nat
  | Z3Formula.assert _       => 1
  | Z3Formula.and lhs rhs     => assertCount lhs + assertCount rhs
  | Z3Formula.or  lhs rhs     => assertCount lhs + assertCount rhs
  | Z3Formula.not inner        => assertCount inner
  | Z3Formula.forall' _ body   => assertCount body

end Capture

/-- `Z3Formula.captures univ validProp f` holds iff:

    * `f` is sound with respect to `validProp`.
    * Every universally-quantified variable in `f` belongs to `univ`.
    * `f` contains at least one assertion. -/
def captures (univ : List String) (validProp : String → Prop) (f : Z3Formula) : Prop :=
  sound validProp f ∧
  Capture.allInUniv univ (Capture.forallVars f) ∧
  Capture.assertCount f > 0

end Z3Formula

end AgentSwarm
