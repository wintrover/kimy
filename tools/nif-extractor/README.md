# nif-extractor

NIF (Nim Intermediate Format) semantic extractor for the AgentSwarm deterministic architecture.

Parses `.nif`, `.deps.nif`, and `.iface.nif` files produced by Nim's Incremental Compilation (IC) pipeline. These files contain macro-expanded, type-checked semantic AST — the ideal source for building symbol contracts for AgentSwarm.

## Why NIF?

Nim's IC pipeline produces three file types after compilation:

| File | Content | Use Case |
|------|---------|----------|
| `.nif` | Full semantic AST after macro expansion | Type signatures, effects, call graphs |
| `.deps.nif` | Static dependency graph | Import/include resolution |
| `.iface.nif` | Interface cookies (checksums) | Change detection, caching |

Unlike `.nim` source, `.nif` files are **semantically complete** — macros are expanded, overloads resolved, types inferred. This makes them the single source of truth for symbol contracts.

## Build

```bash
cd tools/nif-extractor
nimble install  # or: nim c -d:release nif_extractor.nim
```

Requires Nim >= 2.2.0.

## Usage

```bash
# Extract all exported symbols from a project
nif-extractor --project /path/to/nim/project

# Extract specific symbols
nif-extractor --project /path --symbols "z3.solveConstraint" --format contract

# Multiple patterns with depth limit
nif-extractor --project /path --symbols "std/math.*, mymodule.*" --depth 2

# Full format with all metadata
nif-extractor --project /path --include-deps --include-iface --include-macros --format full
```

### Options

| Flag | Description |
|------|-------------|
| `--project PATH` | **Required.** Project root path |
| `--symbols PATTERN` | Comma-separated symbol patterns. Supports: exact, `prefix*`, `*suffix`, `*contains*` |
| `--depth N` | Max recursion depth for nested symbols (0 = unlimited) |
| `--format FORMAT` | `contract` (default), `full`, or `minimal` |
| `--include-deps` | Parse `.deps.nif` files for dependency info |
| `--include-iface` | Parse `.iface.nif` files for interface hashes |
| `--include-macros` | Extract macro expansion metadata |
| `--include-templates` | Extract template overloading info |
| `--verbose` | Print progress to stderr |

## Output Formats

### Contract (default)

Minimal JSON for AgentSwarm consumption:

```json
{
  "format": "kimi-agent-swarm-nif-contract",
  "version": "1.0.0",
  "symbols": [
    {
      "symbol": "z3.solveConstraint",
      "typeSignature": "(constraints: seq[Constraint]): bool",
      "effectPragma": ["gcsafe"],
      "dependencies": [
        { "symbol": "z3.Constraint", "kind": "type-ref" }
      ],
      "macroExpanded": false
    }
  ]
}
```

### Full

Complete symbol information including line numbers, doc comments, nested children, macro expansions, template overloads, and interface hashes.

### Minimal

Just symbol names, kinds, and file locations.

## Architecture

```
nif_extractor.nim
├── Lexer           — Tokenizes raw .nif S-expression text
├── Parser          — Builds NifNode AST from token stream
├── NifNode API     — Navigation/query helpers (findChild, findAll, findDeep)
├── Extractors      — Per-concern extraction:
│   ├── extractTypeSignature()    — Params, return type, generics
│   ├── extractEffectPragma()     — gcsafe, noSideEffect, etc.
│   ├── extractDependencies()     — Imports, includes, calls, type-refs
│   ├── extractMacroExpansion()   — expandedFrom, macroExp
│   └── extractTemplateOverloads() — Collects same-name templates
├── Extractor       — Orchestrates file discovery + symbol extraction
└── CLI             — getopt-based command-line interface
```

## NIF File Discovery

Looks for `.nif` files in standard nimcache locations:

- `<project>/nimcache/`
- `<project>/nimcache/release/`
- `<project>/nimcache/debug/`
- `<project>/.nimcache/`
- `<project>/build/nimcache/`
- `~/.cache/nim/<project>/`

## Integration with AgentSwarm

The contract format output is designed for direct consumption by the AgentSwarm `prompt_template` system:

```typescript
// Example: feeding NIF contracts into agent prompts
const nifOutput = execSync(
  `nif-extractor --project ${projectPath} --symbols "${symbol}" --format contract`
);
const contract = JSON.parse(nifOutput);
// Use contract.symbols to build type-aware agent prompts
```
