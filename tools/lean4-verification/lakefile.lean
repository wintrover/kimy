/-
  lakefile.lean — Lean 4 project configuration for NIF AST verification.

  This project formalizes the NIF (Nim Intermediate Format) AST used by the
  AgentSwarm deterministic architecture. It provides machine-checked
  definitions for NIF node types, type expressions, validity predicates,
  a satisfiability semantics for verifying contract conformance, Z3 formula
  representations, and a translation function with soundness proofs.
-/
import Lake
open Lake DSL

package kimi-nif-verification where
  leanOptions := #[⟨`autoImplicit, false⟩]

@[default_target]
lean_lib NifAst where
  srcDir := "."

lean_lib Z3Formula where
  srcDir := "."

lean_lib Translation where
  srcDir := "."
