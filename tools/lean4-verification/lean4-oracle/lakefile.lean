/-
  lakefile.lean — Lean 4 project configuration for the NIF Oracle Binary.

  A standalone Lake project that provides reference implementations of
  sketch roundtrip, nodeid roundtrip, and spec validation for the NIF
  AST formalization.  Reads JSON from stdin, dispatches commands, and
  writes JSON to stdout.
-/
import Lake
open Lake DSL

package kimi-nif-oracle where
  leanOptions := #[⟨`autoImplicit, false⟩]

@[default_target]
lean_lib Oracle where
  srcDir := "."
  roots := #[`Oracle]
