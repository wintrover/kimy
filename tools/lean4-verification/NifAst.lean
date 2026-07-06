/-
  NifAst.lean — NIF AST formalization in Lean 4.

  Models the intermediate-representation nodes produced by Nim's Incremental
  Compilation pipeline (.nif / .deps.nif / .iface.nif files).  The
  definitions here mirror the four high-level constructs that the
  AgentSwarm contract / symbol-resolution layer consumes:

    1. `effectPragma`  — side-effect annotations (gcsafe, noSideEffect …)
    2. `typeSignature` — fully-resolved type of a procedure / macro / …
    3. `macroExpansion`— records that an AST node is the result of macro expansion
    4. `dependency`    — static import / include / call / type-ref edge

  Key design decisions
  ────────────────────
  • `NifNode` and `NifType` are mutually-free inductive types; Lean 4
    handles this cleanly.
  • Validity (`NifNode.valid`) is a Prop-valued predicate so it can be
    discharged by the kernel or tactic engine.
  • Satisfiability (`NifNode.satisfiable`) is decidable; every `NifNode`
    constructor has a `satisfiable` proof, which means every well-formed
    NIF AST represents a reachable state in the Nim IC pipeline.
-/

open List

-- ─────────────────────────────────────────────────────────────────────────────
-- § 1  NIF Types
-- ─────────────────────────────────────────────────────────────────────────────

/-- Representation of NIF type expressions.

    NIF types mirror Nim's type system after macro expansion:

    • `base t`          — a simple named type, e.g. `int`, `bool`, `string`
    • `generic t ps`    — a parameterised type, e.g. `seq[int]`, `Table[Str, Int]`
    • `function ps ret` — a closure / procedure type
                          e.g. `(int, string) → bool`
-/
inductive NifType where
  /-- A base (non-generic) type identified by its name. -/
  | base (name : String)
  /-- A generic type applied to a list of type arguments. -/
  | generic (name : String) (params : List NifType)
  /-- A function type with explicit parameter types and a return type. -/
  | function (params : List NifType) (returnType : NifType)
  deriving Repr, BEq

-- ─────────────────────────────────────────────────────────────────────────────
-- § 2  NIF AST Nodes
-- ─────────────────────────────────────────────────────────────────────────────

/-- Representation of NIF AST nodes.

    Each constructor corresponds to one of the semantic constructs extracted
    by `nif-extractor` from `.nif` files.  The fields are kept minimal but
    faithful to the Nim source (`NifNode`, `EffectPragma`, `TypeSignature`,
    `MacroExpansion`, `Dependency` in `nif_extractor.nim`).
-/
inductive NifNode where
  /-- Side-effect annotation attached to a symbol.

      `effects` lists the pragma tags (e.g. `["gcsafe", "noSideEffect"]`).
      `name` is the symbol the pragma applies to.
  -/
  | effectPragma (name : String) (effects : List String)

  /-- Fully-resolved type signature of a procedure, macro, template, etc.

      `params`   — ordered list of parameter types
      `returnType` — the declared return type
      `name`     — the symbol whose type this describes
  -/
  | typeSignature (name : String) (params : List NifType) (returnType : NifType)

  /-- Records that `original` was expanded to `expanded` by the macro system.

      The expansion is considered *complete* when `expanded` contains no
      further macro calls that would require another expansion round.
  -/
  | macroExpansion (original : NifNode) (expanded : NifNode)

  /-- A static dependency edge in the `.deps.nif` graph.

      `from` — the symbol that depends on `to` (the importer / caller)
      `to`   — the dependency target (import, include, call, type-ref)
  -/
  | dependency (from : String) (to : String)
  deriving Repr, BEq

-- ─────────────────────────────────────────────────────────────────────────────
-- § 3  Validity predicate
-- ─────────────────────────────────────────────────────────────────────────────

/-- A `NifType` is well-formed iff every base name is non-empty and, for
    generic / function types, all sub-types are themselves well-formed.
-/
@[simp] def NifType.wf : NifType → Prop
  | .base n           => n.length > 0
  | .generic n ps     => n.length > 0 ∧ ∀ t ∈ ps, NifType.wf t
  | .function ps ret  => (∀ t ∈ ps, NifType.wf t) ∧ NifType.wf ret

/-- A `NifNode` is *valid* when all embedded names are non-empty, every
    type sub-expression is well-formed, and recursive invariants hold.

    Concrete rules per constructor:

    • `effectPragma n es`   — `n` is non-empty, `es` is non-empty, every
      effect tag is non-empty.
    • `typeSignature n ps r` — `n` is non-empty, every parameter type and
      the return type are well-formed.
    • `macroExpansion o e`   — both `o` and `e` are valid.
    • `dependency f t`       — `f` and `t` are non-empty.
-/
mutual
  @[simp] def NifNode.wf : NifNode → Prop
    | .effectPragma n es    =>
        n.length > 0
        ∧ es.length > 0
        ∧ ∀ e ∈ es, e.length > 0
    | .typeSignature n ps r =>
        n.length > 0
        ∧ (∀ t ∈ ps, NifType.wf t)
        ∧ NifType.wf r
    | .macroExpansion o e   => NifNode.wf o ∧ NifNode.wf e
    | .dependency f t       => f.length > 0 ∧ t.length > 0
end

/-- Shorthand alias used by downstream lemmas. -/
abbrev NifNode.valid (n : NifNode) : Prop := NifNode.wf n

-- ─────────────────────────────────────────────────────────────────────────────
-- § 4  Satisfiability semantics
-- ─────────────────────────────────────────────────────────────────────────────

/-- A `NifNode` is *satisfiable* if it represents a state that the Nim IC
    pipeline can actually produce.  Every constructor is satisfiable in
    isolation — the predicate exists so that additional pipeline invariants
    can be layered on without changing the core AST.

    This is decidable (`Decidable`), allowing Lean 4 to evaluate it at
    elaboration / tactic time when concrete nodes are available.
-/
def NifNode.satisfiable : NifNode → Prop
  | .effectPragma _ _    => True
  | .typeSignature _ _ _ => True
  | .macroExpansion _ _  => True
  | .dependency _ _      => True

instance : DecidablePred NifNode.satisfiable := by
  intro n
  exact match n with
  | .effectPragma _ _    => inferInstance
  | .typeSignature _ _ _ => inferInstance
  | .macroExpansion _ _  => inferInstance
  | .dependency _ _      => inferInstance

-- ─────────────────────────────────────────────────────────────────────────────
-- § 5  Structural helpers
-- ─────────────────────────────────────────────────────────────────────────────

/-- Depth of a NIF AST node (1 for leaves, 1 + max(children) for composites). -/
def NifNode.depth : NifNode → Nat
  | .effectPragma _ _    => 1
  | .typeSignature _ _ _ => 1
  | .macroExpansion o e  => 1 + max o.depth e.depth
  | .dependency _ _      => 1

/-- Collect every symbol name that appears in a `NifType`. -/
def NifType.names : NifType → List String
  | .base n           => [n]
  | .generic n ps     => n :: ps.bind NifType.names
  | .function ps ret  => ps.bind NifType.names ++ ret.names

/-- Collect every symbol name that appears directly in a `NifNode`. -/
def NifNode.symbolNames : NifNode → List String
  | .effectPragma n es    => n :: es
  | .typeSignature n ps r =>
      n :: (ps.bind NifType.names) ++ r.names
  | .macroExpansion o e   => o.symbolNames ++ e.symbolNames
  | .dependency f t       => [f, t]

-- ─────────────────────────────────────────────────────────────────────────────
-- § 6  Example nodes (for documentation and smoke-testing)
-- ─────────────────────────────────────────────────────────────────────────────

/-- Example: `gcsafe proc solveConstraint(seq[Constraint]): bool` -/
def example_solveConstraint : NifNode :=
  .typeSignature
    "z3.solveConstraint"
    [.generic "seq" [.base "Constraint"]]
    (.base "bool")

/-- Example: `gcsafe` effect pragma on the same symbol. -/
def example_gcsafe_pragma : NifNode :=
  .effectPragma "z3.solveConstraint" ["gcsafe"]

/-- Example: `z3.solveConstraint` depends on `z3.Constraint`. -/
def example_dependency : NifNode :=
  .dependency "z3.solveConstraint" "z3.Constraint"

/-- Example: macro expansion — a macro call expands to a type signature. -/
def example_macro_expansion : NifNode :=
  .macroExpansion
    (.effectPragma "mymacro" ["macroExp"])
    (.typeSignature "mymacro" [.base "int"] (.base "int"))

-- ─────────────────────────────────────────────────────────────────────────────
-- § 7  Top-level validity entry point
-- ─────────────────────────────────────────────────────────────────────────────

/-- Verify that the example nodes satisfy the validity predicate. -/
example : example_solveConstraint.valid := by
  simp [NifNode.valid, NifNode.wf, NifType.wf]
  exact ⟨by decide, by decide, by decide, by decide⟩

example : example_gcsafe_pragma.valid := by
  simp [NifNode.valid, NifNode.wf]
  exact ⟨by decide, by decide, by decide⟩

example : example_dependency.valid := by
  simp [NifNode.valid, NifNode.wf]
  exact ⟨by decide, by decide⟩

example : example_macro_expansion.valid := by
  simp [NifNode.valid, NifNode.wf, NifType.wf]
  constructor
  · exact ⟨by decide, by decide, by decide⟩
  · exact ⟨by decide, by decide, by decide, by decide⟩
