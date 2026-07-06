import type { AgentContract } from './contract-validator';

// ---------------------------------------------------------------------------
// NIF data shapes (matches nif-extractor JSON output)
// ---------------------------------------------------------------------------

/** NIF contract JSON output from `nif-extractor --format contract`. */
export interface NifContractOutput {
  readonly format: 'kimi-agent-swarm-nif-contract';
  readonly version: string;
  readonly symbols: readonly NifSymbol[];
}

/** A single symbol extracted from a NIF file. */
export interface NifSymbol {
  readonly symbol: string;
  readonly kind?: string | undefined;
  readonly typeSignature?: string | undefined;
  readonly effectPragma?: readonly string[] | undefined;
  readonly dependencies?: readonly NifDependency[] | undefined;
  readonly macroExpanded?: boolean | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

/** A dependency edge from NIF analysis. */
export interface NifDependency {
  readonly symbol: string;
  readonly kind: 'import' | 'include' | 'call' | 'type-ref';
  readonly path?: string | undefined;
}

// ---------------------------------------------------------------------------
// Constraint output types
// ---------------------------------------------------------------------------

/**
 * ConstraintSet is the output of NIF-to-Z3 translation. It contains
 * Z3 assertion strings ready for SMT-LIB input, plus structured
 * metadata for programmatic inspection.
 */
export interface ConstraintSet {
  /** Z3 SMT-LIB assertion strings (one per constraint). */
  readonly z3Assertions: string[];
  /** Symbol → effect tags mapping. */
  readonly effects: Map<string, string[]>;
  /** Symbol → return type mapping. */
  readonly typeConstraints: Map<string, string>;
  /** Whether the constraints came from NIF, tree-sitter, or both. */
  readonly source: 'nif' | 'tree-sitter' | 'hybrid';
}

// ---------------------------------------------------------------------------
// Known Nim effect tags → semantic categories
// ---------------------------------------------------------------------------

/**
 * Maps Nim effect pragma tags to Z3-compatible semantic categories.
 * Tags not in this map are passed through verbatim.
 */
const EFFECT_TAG_MAP: Record<string, string> = {
  gcsafe: 'GCSafe',
  noSideEffect: 'Pure',
  noEffect: 'Pure',
  nosideeffect: 'Pure',
  WriteIOEffect: 'IOEffect',
  ReadIOEffect: 'IOEffect',
  IOEffect: 'IOEffect',
  RootEffect: 'RootEffect',
  ClosureEnv: 'ClosureCapture',
  TagEffect: 'Tagged',
  AxiomEffect: 'Axiom',
};

// ---------------------------------------------------------------------------
// NIF S-expression light parser
// ---------------------------------------------------------------------------

interface NifSExpr {
  readonly tag: string;
  readonly children: readonly NifSExpr[];
  readonly text: string;
}

/**
 * Minimal S-expression parser for NIF syntax.  Handles the same grammar
 * as the Nim nif-extractor: nested `(tag child…)` forms plus bare
 * identifiers and quoted strings.
 */
function parseNifSExprs(input: string): NifSExpr[] {
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < input.length && (input[pos] === ' ' || input[pos] === '\t' || input[pos] === '\n' || input[pos] === '\r')) {
      pos++;
    }
    // Skip line comments (`; …`)
    while (pos < input.length && input[pos] === ';') {
      while (pos < input.length && input[pos] !== '\n') pos++;
      while (pos < input.length && (input[pos] === ' ' || input[pos] === '\t' || input[pos] === '\n' || input[pos] === '\r')) {
        pos++;
      }
    }
  }

  function readString(): string {
    pos++; // skip opening "
    let result = '';
    while (pos < input.length && input[pos] !== '"') {
      if (input[pos] === '\\' && pos + 1 < input.length) {
        pos++;
        const esc = input[pos];
        if (esc === 'n') result += '\n';
        else if (esc === 't') result += '\t';
        else result += esc;
      } else {
        result += input[pos];
      }
      pos++;
    }
    pos++; // skip closing "
    return result;
  }

  function readIdent(): string {
    const start = pos;
    while (pos < input.length && input[pos] !== undefined && !"() \t\n\r;\"".includes(input[pos]!)) {
      pos++;
    }
    return input.slice(start, pos);
  }

  function parseOne(): NifSExpr | undefined {
    skipWhitespace();
    if (pos >= input.length) return undefined;

    if (input[pos] === '(') {
      pos++; // skip (
      skipWhitespace();
      const children: NifSExpr[] = [];
      while (pos < input.length && input[pos] !== ')') {
        const child = parseOne();
        if (child !== undefined) children.push(child);
        skipWhitespace();
      }
      if (pos < input.length) pos++; // skip )
      const tag = children.length > 0 && children[0] !== undefined ? children[0].text : '';
      return { tag, children, text: tag };
    }

    if (input[pos] === '"') {
      const text = readString();
      return { tag: '', children: [], text };
    }

    const ident = readIdent();
    return { tag: '', children: [], text: ident };
  }

  const results: NifSExpr[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    skipWhitespace();
    if (pos >= input.length) break;
    const node = parseOne();
    if (node !== undefined) results.push(node);
  }
  return results;
}

// ---------------------------------------------------------------------------
// NIF data helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from a single NIF S-expression node tree.
 * Walks to the first leaf node and returns its text.
 */
function getText(node: NifSExpr | undefined): string {
  if (node === undefined) return '';
  if (node.children.length === 0) return node.text;
  return getText(node.children[0]);
}

/** Find the first child of an S-expression whose text matches the given tag. */
function findChild(parent: NifSExpr, tag: string): NifSExpr | undefined {
  for (const child of parent.children) {
    if (getText(child) === tag) return child;
  }
  return undefined;
}

/** Find all children whose text matches the given tag. */
function findAll(parent: NifSExpr, tag: string): NifSExpr[] {
  return parent.children.filter((c) => getText(c) === tag);
}

// ---------------------------------------------------------------------------
// Phase 1: Immediate NIF semantic extraction
// ---------------------------------------------------------------------------

/**
 * Extract effect tags from a single NIF symbol node.
 *
 * Looks for `(pragma (efx "tag")…)`, `(efx "tag"…)`, and
 * `(effects "tag"…)` sub-nodes — matching the Nim nif-extractor's
 * `extractEffectPragma()` logic.
 */
function extractEffectTags(node: NifSExpr): string[] {
  const tags: string[] = [];

  // (pragma (efx "gcsafe") (efx "tags" "WriteIOEffect"))
  const pragmaNode = findChild(node, 'pragma');
  if (pragmaNode !== undefined) {
    for (const child of pragmaNode.children) {
      const childTag = getText(child);
      if (childTag === 'efx' || childTag === 'effects' || childTag === 'tags') {
        // Skip the tag name itself; collect the remaining children as effect names
        for (let i = 1; i < child.children.length; i++) {
          const t = getText(child.children[i]);
          if (t.length > 0) tags.push(t);
        }
      }
    }
  }

  // (efx "gcsafe" "noSideEffect")
  const efxNode = findChild(node, 'efx');
  if (efxNode !== undefined) {
    for (const child of efxNode.children) {
      const t = getText(child);
      if (t.length > 0 && !tags.includes(t)) tags.push(t);
    }
  }

  // (effects "ReadIOEffect")
  const effectsNode = findChild(node, 'effects');
  if (effectsNode !== undefined) {
    for (const child of effectsNode.children) {
      const t = getText(child);
      if (t.length > 0 && !tags.includes(t)) tags.push(t);
    }
  }

  return tags;
}

/**
 * Extract return type from a NIF symbol node's `(ret …)` child.
 */
function extractReturnType(node: NifSExpr): string {
  const retNode = findChild(node, 'ret');
  if (retNode === undefined) return '';
  return getText(retNode);
}

/**
 * Extract parameter types from a NIF symbol node's `(params …)` child.
 */
function extractParamTypes(node: NifSExpr): Array<{ name: string; typeStr: string }> {
  const params: Array<{ name: string; typeStr: string }> = [];
  const paramsNode = findChild(node, 'params');
  if (paramsNode === undefined) return params;

  for (const child of paramsNode.children) {
    if (child.children.length >= 2) {
      params.push({
        name: getText(child.children[0]),
        typeStr: getText(child.children[1]),
      });
    } else if (child.children.length === 1) {
      params.push({ name: '', typeStr: getText(child.children[0]) });
    }
  }

  return params;
}

/**
 * Check whether a NIF symbol was produced by macro expansion.
 * This is critical because macro-injected effects are only visible in NIF,
 * not in tree-sitter analysis of source code.
 */
function wasMacroExpanded(node: NifSExpr): boolean {
  return findChild(node, 'expandedFrom') !== undefined || findChild(node, 'macroExp') !== undefined;
}

// ---------------------------------------------------------------------------
// Z3 assertion formatting
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion in an SMT-LIB string literal.
 */
function escapeSmtString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Format a single effect assertion for Z3.
 *
 * Rule: NIF `{.tags: [FooEffect].}` → Z3 `(assert (has_tag func "FooEffect"))`
 */
function formatEffectAssertion(funcName: string, tag: string): string {
  const mapped = EFFECT_TAG_MAP[tag] ?? tag;
  return `(assert (has_tag "${escapeSmtString(funcName)}" "${escapeSmtString(mapped)}"))`;
}

/**
 * Format a return-type assertion for Z3.
 *
 * Rule: NIF `proc f(): T` → Z3 `(assert (= (return_type f) T))`
 */
function formatReturnTypeAssertion(funcName: string, returnType: string): string {
  return `(assert (= (return_type "${escapeSmtString(funcName)}") "${escapeSmtString(returnType)}"))`;
}

/**
 * Format a parameter-type assertion for Z3.
 */
function formatParamTypeAssertion(funcName: string, paramName: string, paramType: string): string {
  return `(assert (= (param_type "${escapeSmtString(funcName)}" "${escapeSmtString(paramName)}") "${escapeSmtString(paramType)}"))`;
}

/**
 * Format a macro-expansion marker assertion for Z3.
 * Macro-injected effects are only capturable from NIF, not tree-sitter.
 */
function formatMacroExpandedAssertion(funcName: string): string {
  return `(assert (macro_expanded "${escapeSmtString(funcName)}" true))`;
}

// ---------------------------------------------------------------------------
// Public API: translateNifToConstraints
// ---------------------------------------------------------------------------

/**
 * Translate NIF data into Z3 constraints.
 *
 * Accepts either:
 * - A `NifContractOutput` JSON object (from `nif-extractor --format contract`)
 * - A raw NIF S-expression string (for direct integration)
 * - A pre-parsed array of `NifSExpr` nodes
 *
 * **Two-phase design:**
 * - **Phase 1 (current):** Parse NIF data for effect pragmas, type signatures.
 * - **Phase 2 (future):** Embed the Nim compiler frontend API directly for
 *   deeper semantic analysis without requiring NIF file I/O.
 */
export function translateNifToConstraints(nifData: unknown): ConstraintSet {
  const z3Assertions: string[] = [];
  const effects = new Map<string, string[]>();
  const typeConstraints = new Map<string, string>();

  let symbols: Array<{ name: string; node?: NifSExpr | undefined; json?: NifSymbol | undefined }> = [];

  // ── Parse input form ────────────────────────────────────────────────────
  if (Array.isArray(nifData) && nifData.length > 0 && typeof nifData[0] === 'object' && 'tag' in nifData[0]) {
    // Already-parsed NifSExpr array
    for (const root of nifData as NifSExpr[]) {
      if (root.children.length > 0) {
        const nameChild = findChild(root, 'name');
        const name = nameChild !== undefined ? getText(nameChild) : getText(root.children[0]);
        if (name.length > 0) {
          symbols.push({ name, node: root });
        }
      }
    }
  } else if (typeof nifData === 'string') {
    // Raw NIF S-expression text
    const nodes = parseNifSExprs(nifData);
    for (const root of nodes) {
      if (root.children.length > 0) {
        const nameChild = findChild(root, 'name');
        const name = nameChild !== undefined ? getText(nameChild) : getText(root.children[0]);
        if (name.length > 0) {
          symbols.push({ name, node: root });
        }
      }
    }
  } else if (typeof nifData === 'object' && nifData !== null && 'symbols' in nifData) {
    // NifContractOutput JSON
    const contract = nifData as NifContractOutput;
    for (const sym of contract.symbols) {
      symbols.push({ name: sym.symbol, json: sym });
    }
  }

  // ── Phase 1: Extract semantic constraints from each symbol ──────────────
  for (const sym of symbols) {
    const name = sym.name;

    // --- Effects ---
    let symTags: string[];
    if (sym.json !== undefined) {
      symTags = [...(sym.json.effectPragma ?? [])];
    } else if (sym.node !== undefined) {
      symTags = extractEffectTags(sym.node);
    } else {
      symTags = [];
    }

    if (symTags.length > 0) {
      effects.set(name, symTags);
      for (const tag of symTags) {
        z3Assertions.push(formatEffectAssertion(name, tag));
      }
    }

    // --- Return type ---
    let returnType: string;
    if (sym.json !== undefined) {
      returnType = sym.json.typeSignature ?? '';
      // If the typeSignature is a full signature string like "(x: int): bool",
      // extract just the return type after the last `:`
      const colonIdx = returnType.lastIndexOf('):');
      if (colonIdx !== -1) {
        returnType = returnType.slice(colonIdx + 2).trim();
      } else if (returnType.startsWith('(')) {
        // Signature without explicit return — skip
        returnType = '';
      }
    } else if (sym.node !== undefined) {
      returnType = extractReturnType(sym.node);
    } else {
      returnType = '';
    }

    if (returnType.length > 0) {
      typeConstraints.set(name, returnType);
      z3Assertions.push(formatReturnTypeAssertion(name, returnType));
    }

    // --- Parameter types (NIF node path only) ---
    if (sym.node !== undefined) {
      const params = extractParamTypes(sym.node);
      for (const param of params) {
        if (param.typeStr.length > 0) {
          z3Assertions.push(formatParamTypeAssertion(name, param.name, param.typeStr));
        }
      }
    }

    // --- Macro expansion marker ---
    if (sym.json !== undefined && sym.json.macroExpanded === true) {
      z3Assertions.push(formatMacroExpandedAssertion(name));
    } else if (sym.node !== undefined && wasMacroExpanded(sym.node)) {
      z3Assertions.push(formatMacroExpandedAssertion(name));
    }
  }

  return {
    z3Assertions,
    effects,
    typeConstraints,
    source: 'nif',
  };
}

// ---------------------------------------------------------------------------
// Public API: translateContractToZ3
// ---------------------------------------------------------------------------

/**
 * Translate an `AgentContract` into Z3 assertion strings.
 *
 * Each allowed effect becomes a positive assertion; each prohibited effect
 * becomes a negated assertion. Type constraints from the contract are also
 * encoded when present.
 */
export function translateContractToZ3(contract: AgentContract): string[] {
  const assertions: string[] = [];
  const contractId = escapeSmtString(contract.id);

  // Mark the contract identity for Z3.
  assertions.push(`(declare-const contract_${contractId} Contract)`);

  // Allowed effects → positive assertions.
  for (const effect of contract.allowedEffects) {
    const tag = EFFECT_TAG_MAP[effect.kind] ?? effect.kind;
    assertions.push(`(assert (allowed_effect contract_${contractId} "${escapeSmtString(tag)}"))`);
    if (effect.pattern !== undefined) {
      assertions.push(
        `(assert (effect_pattern contract_${contractId} "${escapeSmtString(tag)}" "${escapeSmtString(effect.pattern)}"))`,
      );
    }
  }

  // Prohibited effects → negative assertions.
  for (const effect of contract.prohibitedEffects) {
    const tag = EFFECT_TAG_MAP[effect.kind] ?? effect.kind;
    assertions.push(`(assert (not (allowed_effect contract_${contractId} "${escapeSmtString(tag)}")))`);
    if (effect.pattern !== undefined) {
      assertions.push(
        `(assert (not (effect_pattern contract_${contractId} "${escapeSmtString(tag)}" "${escapeSmtString(effect.pattern)}")))`,
      );
    }
  }

  // Input type constraint.
  if (contract.inputType !== undefined) {
    assertions.push(
      `(assert (= (input_type contract_${contractId}) "${escapeSmtString(contract.inputType)}"))`,
    );
  }

  // Output type constraint.
  if (contract.outputType !== undefined) {
    assertions.push(
      `(assert (= (output_type contract_${contractId}) "${escapeSmtString(contract.outputType)}"))`,
    );
  }

  return assertions;
}

// ---------------------------------------------------------------------------
// Phase 2 placeholder: Nim compiler frontend API
// ---------------------------------------------------------------------------

/**
 * Future entry point for Phase 2: direct Nim compiler frontend API embedding.
 *
 * Instead of parsing NIF files on disk, this would call into the Nim compiler's
 * semantic analysis API to obtain the same structured data.  The function is
 * declared now so downstream code can plan for the integration without needing
 * to change call sites when Phase 2 ships.
 *
 * @remarks
 * Phase 2 is blocked on:
 * 1. Nim compiler embedding API stability (Nim ≥ 2.4 target)
 * 2. WASM/N-API bindings for the compiler frontend
 * 3. Thread-safety audit of the compiler's semantic pass
 */
export async function translateNifViaCompilerFrontend(
  _projectPath: string,
  _symbols?: readonly string[],
): Promise<ConstraintSet> {
  throw new Error(
    'Phase 2 (Nim compiler frontend embedding) is not yet implemented. ' +
    'Use translateNifToConstraints() with NIF file data instead.',
  );
}
