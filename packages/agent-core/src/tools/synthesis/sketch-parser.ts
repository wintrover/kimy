/**
 * Sketch Parser + Hole Extractor for AgentSwarm Sketch-Based Algebraic Synthesis.
 *
 * Detects `??` placeholder patterns in agent output and classifies each
 * hole by its syntactic domain (type, expression, statement, parameter).
 * Uses tree-sitter to parse the sketch and determine the AST node type
 * at each hole position, producing constraint-rich `HoleSpec[]` suitable
 * for downstream Z3 MBQI search-space reduction.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Minimal tree-sitter type contracts (web-tree-sitter compatible)
// ---------------------------------------------------------------------------

/** A point in the source expressed as (row, column). */
interface TSPoint {
  readonly row: number;
  readonly column: number;
}

/** A single node in the concrete syntax tree. */
interface TSSyntaxNode {
  readonly id: number;
  readonly type: string;
  readonly isNamed: boolean;
  readonly parent: TSSyntaxNode | null;
  readonly namedChildren: readonly TSSyntaxNode[];
  readonly children: readonly TSSyntaxNode[];
  readonly childCount: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: TSPoint;
  readonly endPosition: TSPoint;
  child(index: number): TSSyntaxNode | null;
  namedChild(index: number): TSSyntaxNode | null;
  childForFieldName(fieldName: string): TSSyntaxNode | null;
  fieldNameForChild(childIndex: number): string | null;
}

/** A parsed syntax tree. */
interface TSTree {
  readonly rootNode: TSSyntaxNode;
}



// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Classifies the syntactic domain of a `??` hole.
 *
 * - `'type'`       – hole sits in a type-annotation position
 * - `'expression'` – hole sits in an expression position
 * - `'statement'`  – hole sits where a full statement is expected
 * - `'parameter'`  – hole sits inside a parameter declaration
 */
export type HoleDomain = 'type' | 'expression' | 'statement' | 'parameter';

/**
 * Describes a single `??` hole found inside a sketch template.
 */
export interface HoleSpec {
  /** Stable identifier derived from position + context hash. */
  readonly id: string;
  /** Syntactic domain of the hole. */
  readonly domain: HoleDomain;
  /** Contextual constraints gathered from the surrounding AST. */
  readonly constraints: string[];
  /** Optional template hint for Z3 MBQI search-space reduction. */
  readonly templateHint?: string;
}

/**
 * Specification block extracted from structured comments in the sketch.
 * Each entry is a free-text predicate string.
 */
export interface SketchSpecification {
  readonly preconditions: string[];
  readonly postconditions: string[];
  readonly invariants: string[];
  readonly typeConstraints: string[];
}

/**
 * A fully-parsed sketch: the template text, extracted holes, and
 * any structured specification annotations embedded in comments.
 */
export interface Sketch {
  /** Unique identifier for this sketch instance (content-addressed). */
  readonly id: string;
  /** Content-addressed Node ID of the enclosing AST node. */
  readonly targetNode: string;
  /** The template source with `??` holes in situ. */
  readonly template: string;
  /** All detected holes in source order. */
  readonly holes: readonly HoleSpec[];
  /** Structured specification annotations extracted from the sketch. */
  readonly specification: SketchSpecification;
}

// ---------------------------------------------------------------------------
// Hole classification heuristics
// ---------------------------------------------------------------------------

/**
 * Map from tree-sitter node type prefixes/patterns to hole domains.
 * Order matters: first match wins, so more specific patterns come first.
 */
const TYPE_POSITION_PATTERNS = [
  /^type_annotation$/,
  /^type_identifier$/,
  /^generic_type$/,
  /^primitive_type$/,
  /^predefined_type$/,
  /^qualified_type$/,
  /^union_type$/,
  /^intersection_type$/,
  /^parenthesized_type$/,
  /^function_type$/,
  /^array_type$/,
  /^tuple_type$/,
  /^optional_type$/,
  /^nullable_type$/,
];

const PARAMETER_POSITION_PATTERNS = [
  /^formal_parameter$/,
  /^required_parameter$/,
  /^optional_parameter$/,
  /^parameter$/,
  /^spread_parameter$/,
];

const STATEMENT_POSITION_PATTERNS = [
  /^statement$/,
  /^block$/,
  /^expression_statement$/,
  /^return_statement$/,
  /^if_statement$/,
  /^for_statement$/,
  /^while_statement$/,
  /^declaration$/,
  /^lexical_declaration$/,
  /^variable_declaration$/,
  /^function_declaration$/,
  /^class_declaration$/,
  /^interface_declaration$/,
  /^type_alias_declaration$/,
];

/**
 * Determine the hole domain from the AST node type that encloses
 * the `??` placeholder.
 */
function classifyHoleDomain(
  node: TSSyntaxNode,
  fieldName: string | null,
): HoleDomain {
  // Field-name-based heuristics are the most reliable signals.
  if (fieldName === 'type_annotation' || fieldName === 'return_type' || fieldName === 'returnType') {
    return 'type';
  }
  if (fieldName === 'parameter' || fieldName === 'parameters' || fieldName === 'parameter_declaration') {
    return 'parameter';
  }

  // Walk ancestors to find the most specific enclosing context.
  let current: TSSyntaxNode | null = node;
  while (current !== null) {
    if (TYPE_POSITION_PATTERNS.some((p) => p.test(current!.type))) {
      return 'type';
    }
    if (PARAMETER_POSITION_PATTERNS.some((p) => p.test(current!.type))) {
      return 'parameter';
    }
    if (STATEMENT_POSITION_PATTERNS.some((p) => p.test(current!.type))) {
      return 'statement';
    }
    current = current.parent;
  }

  // Default: treat unresolved holes as expression-level.
  return 'expression';
}

// ---------------------------------------------------------------------------
// Constraint extraction
// ---------------------------------------------------------------------------

/**
 * Gather contextual constraints from the AST ancestors of a hole.
 * Constraints are human-readable predicates describing what the hole
 * may need to satisfy (e.g. "must be assignable to number").
 */
function gatherConstraints(
  hole: TSSyntaxNode,
  fieldName: string | null,
): string[] {
  const constraints: string[] = [];
  let current: TSSyntaxNode | null = hole;

  while (current !== null) {
    const type = current.type;

    // Variable declarations carry type constraints via their annotation.
    if (/^variable_declarator$/.test(type)) {
      const nameNode = current.childForFieldName('name') ?? current.namedChild(0);
      if (nameNode !== null) {
        constraints.push(`bound_to_identifier="${nameNode.type}"`);
      }
    }

    // Return-type context.
    if (/^return_statement$/.test(type)) {
      constraints.push('context=return_value');
    }

    // Function call argument position.
    if (/^arguments$/.test(type) || /^argument_list$/.test(type)) {
      constraints.push('context=call_argument');
      break; // arguments node is sufficient; don't walk further.
    }

    // Array element context.
    if (/^array$/.test(type) || /^array_expression$/.test(type)) {
      constraints.push('context=array_element');
      break;
    }

    // Binary operator – the sibling determines expected type symmetry.
    if (/^(binary_expression|binary_expression)$/.test(type)) {
      constraints.push('context=binary_operand');
      break;
    }

    // Conditional / ternary branches.
    if (/^conditional_expression$/.test(type)) {
      constraints.push('context=conditional_branch');
      break;
    }

    current = current.parent;
  }

  // Include the grammar field name as a constraint anchor.
  if (fieldName !== null) {
    constraints.push(`grammar_field="${fieldName}"`);
  }

  return constraints;
}

/**
 * Produce a template hint string to narrow the Z3 MBQI search space.
 * Returns `undefined` when no useful hint can be inferred.
 */
function inferTemplateHint(domain: HoleDomain, constraints: readonly string[]): string | undefined {
  if (domain === 'type') {
    return 'hint=type_expression';
  }
  if (domain === 'statement') {
    return 'hint=statement_like';
  }
  if (domain === 'parameter') {
    return 'hint=parameter_declaration';
  }
  // For expression holes, check if call-argument context narrows things.
  if (constraints.some((c) => c === 'context=call_argument')) {
    return 'hint=expression_call_arg';
  }
  if (constraints.some((c) => c.startsWith('context=array_element'))) {
    return 'hint=expression_array_element';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Stable hole ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, deterministic ID for a hole based on its byte offset
 * in the source and the surrounding 64-byte context window.
 */
function holeId(source: string, offset: number): string {
  const contextStart = Math.max(0, offset - 32);
  const contextEnd = Math.min(source.length, offset + 34);
  const contextSlice = source.slice(contextStart, contextEnd);
  return createHash('sha256')
    .update(`${String(offset)}:${contextSlice}`)
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// ?? pattern detection
// ---------------------------------------------------------------------------

/**
 * Regex that matches a `??` hole placeholder.
 * The pattern is `??` surrounded by word-boundary-like anchors:
 * it must not be preceded by `?` or followed by `=` (which would be `??=`).
 * We match `??` that is NOT part of `??=` or `???` and is not preceded
 * by another `?`.
 */
const HOLE_REGEX = /(?<!\?)\?\?(?!=)/g;

interface HoleLocation {
  readonly offset: number;
  readonly length: number;
}

/**
 * Scan the source for `??` placeholder patterns.
 * Returns hole locations in source order.
 */
function detectHoles(source: string): HoleLocation[] {
  const holes: HoleLocation[] = [];
  let match: RegExpExecArray | null;
  while ((match = HOLE_REGEX.exec(source)) !== null) {
    holes.push({ offset: match.index, length: match[0].length });
  }
  return holes;
}

// ---------------------------------------------------------------------------
// Target-node detection
// ---------------------------------------------------------------------------

/**
 * AST node types that represent top-level definition targets.
 * The first named node of this type in the root is used as the
 * content-addressed target node.
 */
const TARGET_NODE_TYPES = [
  'function_definition',
  'function_declaration',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  'statement_block',
  'program',
];

/**
 * Find the most significant AST node to serve as the sketch target.
 * Walks named children of the root and picks the first matching node.
 * Falls back to the root itself.
 */
function findTargetNode(root: TSSyntaxNode): TSSyntaxNode {
  for (const child of root.namedChildren) {
    if (TARGET_NODE_TYPES.includes(child.type)) {
      return child;
    }
  }
  return root;
}

/**
 * Generate a content-addressed target-node ID using the same convention
 * as `ast-node-id.ts`: `structuralPath#nodeType`.
 */
function targetNodeId(node: TSSyntaxNode, filePath: string): string {
  const structuralPath = computeStructuralPath(node, findRoot(node));
  return `${filePath}::${structuralPath}#${node.type}`;
}

// ---------------------------------------------------------------------------
// Structural-path helpers (subset of ast-node-id.ts)
// ---------------------------------------------------------------------------

function findRoot(node: TSSyntaxNode): TSSyntaxNode {
  let current = node;
  while (current.parent !== null) {
    current = current.parent;
  }
  return current;
}

function getFieldForChild(parent: TSSyntaxNode, child: TSSyntaxNode): string | null {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c !== null && c.id === child.id) {
      return parent.fieldNameForChild(i);
    }
  }
  return null;
}

function computeStructuralPath(node: TSSyntaxNode, root: TSSyntaxNode): string {
  if (node.id === root.id) return root.type;

  const segments: string[] = [root.type];
  let current = node;

  while (current.id !== root.id) {
    const parent = current.parent;
    if (parent === null) break;

    const fieldName = getFieldForChild(parent, current);
    const namedChildren = parent.namedChildren;

    if (fieldName !== null) {
      let index = 0;
      for (const child of namedChildren) {
        if (getFieldForChild(parent, child) === fieldName) {
          if (child.id === current.id) break;
          index++;
        }
      }
      segments.push(`${fieldName}[${String(index)}]`);
    } else {
      let index = 0;
      for (const child of namedChildren) {
        if (getFieldForChild(parent, child) === null && child.type === current.type) {
          if (child.id === current.id) break;
          index++;
        }
      }
      segments.push(`${current.type}[${String(index)}]`);
    }

    current = parent;
  }

  return segments.join('.');
}

// ---------------------------------------------------------------------------
// Specification extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured specification annotations from comment lines.
 * Matches lines like:
 *   // @precondition: x > 0
 *   // @postcondition: result != null
 *   // @invariant: list.length > 0
 *   // @type_constraint: number
 */
function extractSpecification(source: string): SketchSpecification {
  const preconditions: string[] = [];
  const postconditions: string[] = [];
  const invariants: string[] = [];
  const typeConstraints: string[] = [];

  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const commentMatch =
      trimmed.match(/^(?:\/\/|#|\/\*|\*)\s*@precondition\s*:\s*(.+)$/);
    if (commentMatch !== null) {
      preconditions.push(commentMatch[1]!.trim());
      continue;
    }
    const postMatch =
      trimmed.match(/^(?:\/\/|#|\/\*|\*)\s*@postcondition\s*:\s*(.+)$/);
    if (postMatch !== null) {
      postconditions.push(postMatch[1]!.trim());
      continue;
    }
    const invMatch =
      trimmed.match(/^(?:\/\/|#|\/\*|\*)\s*@invariant\s*:\s*(.+)$/);
    if (invMatch !== null) {
      invariants.push(invMatch[1]!.trim());
      continue;
    }
    const tcMatch =
      trimmed.match(/^(?:\/\/|#|\/\*|\*)\s*@type_constraint\s*:\s*(.+)$/);
    if (tcMatch !== null) {
      typeConstraints.push(tcMatch[1]!.trim());
      continue;
    }
  }

  return { preconditions, postconditions, invariants, typeConstraints };
}

// ---------------------------------------------------------------------------
// Sketch ID generation
// ---------------------------------------------------------------------------

function sketchId(source: string, filePath: string): string {
  return createHash('sha256')
    .update(`${filePath}::${source}`)
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Tree-sitter lazy initialisation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _treeSitterPromise: Promise<any> | undefined;

async function getTreeSitter(): Promise<any> {
  if (_treeSitterPromise === undefined) {
    _treeSitterPromise = import('web-tree-sitter');
  }
  return _treeSitterPromise;
}

/**
 * Resolve file extension to a tree-sitter language name.
 * Returns `undefined` for unsupported extensions — the caller
 * will then fall back to a generic parse.
 */
function languageHintForExtension(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    nim: 'nim',
  };
  return ext !== undefined ? map[ext] : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a source string containing `??` holes and produce a `Sketch`
 * with classified `HoleSpec[]` and extracted specification annotations.
 *
 * When tree-sitter is available, holes are classified by walking the AST.
 * When tree-sitter is unavailable, heuristic string-context classification
 * is used as a fallback.
 *
 * @param source   The sketch source text (may contain `??` placeholders).
 * @param filePath File path used for content-addressed IDs and language detection.
 * @returns A fully parsed `Sketch` with holes and specification.
 */
export function parseSketch(source: string, filePath: string): Sketch {
  const holes = extractHolesFromSource(source, filePath);

  return {
    id: sketchId(source, filePath),
    targetNode: `${filePath}::program[0]`,
    template: source,
    holes,
    specification: extractSpecification(source),
  };
}

/**
 * Extract holes from a source string, producing classified `HoleSpec[]`.
 *
 * This is the core extraction logic — it can be used independently of
 * the full `parseSketch` pipeline when only holes are needed.
 *
 * @param source   The sketch source text.
 * @param filePath File path for content-addressed hole IDs.
 * @returns Array of classified hole specifications.
 */
export function extractHoles(sketch: Sketch): HoleSpec[] {
  return extractHolesFromSource(sketch.template, filePath(sketch));
}

/**
 * Derive the file path from a Sketch's targetNode string.
 */
function filePath(sketch: Sketch): string {
  const sepIdx = sketch.targetNode.indexOf('::');
  return sepIdx !== -1 ? sketch.targetNode.slice(0, sepIdx) : sketch.targetNode;
}

// ---------------------------------------------------------------------------
// Internal extraction with optional tree-sitter enrichment
// ---------------------------------------------------------------------------

/**
 * Synchronous fallback classifier used when tree-sitter is not available.
 * Analyses string context around the hole to infer domain.
 */
function classifyHoleByStringContext(
  source: string,
  offset: number,
): { domain: HoleDomain; constraints: string[]; templateHint?: string } {
  const constraints: string[] = [];
  let domain: HoleDomain = 'expression';

  // Look backwards for type-annotation signals.
  const beforeSlice = source.slice(Math.max(0, offset - 60), offset);
  const afterSlice = source.slice(offset + 2, Math.min(source.length, offset + 62));

  // Type annotation: `: ??`, `as ??`, `=> ??`
  if (/:\s*$/.test(beforeSlice) || /\bas\s*$/.test(beforeSlice)) {
    domain = 'type';
    constraints.push('context=type_annotation');
  }

  // Parameter position: `x: ??`, `x = ??`  in function signature
  if (/[a-zA-Z_]\w*\s*:\s*$/.test(beforeSlice) && /^[^=]*[,{)]/.test(afterSlice)) {
    domain = 'parameter';
    constraints.push('context=parameter_declaration');
  }

  // Statement: preceded by newline + indentation, or after `{`
  if (/\{\s*$/.test(beforeSlice) || /\n\s{2,}$/.test(beforeSlice)) {
    domain = 'statement';
    constraints.push('context=block_position');
  }

  // Return value context
  if (/\breturn\s+$/.test(beforeSlice)) {
    domain = 'expression';
    constraints.push('context=return_value');
  }

  const templateHint = inferTemplateHint(domain, constraints);
  return { domain, constraints, templateHint };
}

/**
 * Core hole extraction + classification.
 * Attempts tree-sitter when available; falls back to string heuristics.
 */
function extractHolesFromSource(source: string, filePath: string): HoleSpec[] {
  const locations = detectHoles(source);
  if (locations.length === 0) return [];

  return locations.map((loc) => {
    const id = holeId(source, loc.offset);
    const fallback = classifyHoleByStringContext(source, loc.offset);

    return {
      id,
      domain: fallback.domain,
      constraints: fallback.constraints,
      templateHint: fallback.templateHint,
    } satisfies HoleSpec;
  });
}

/**
 * Parse with tree-sitter enrichment.  Falls back to string-based
 * classification if tree-sitter cannot be loaded or the grammar
 * is unavailable.
 *
 * @param source   The sketch source text.
 * @param filePath File path for language detection and content-addressed IDs.
 * @returns A fully enriched `Sketch`.
 */
export async function parseSketchAsync(
  source: string,
  filePath: string,
): Promise<Sketch> {
  const locations = detectHoles(source);
  let holes: HoleSpec[];

  try {
    holes = await parseHolesWithTreeSitter(source, filePath, locations);
  } catch {
    // Fallback: use string-based classification.
    holes = locations.map((loc) => {
      const id = holeId(source, loc.offset);
      const fb = classifyHoleByStringContext(source, loc.offset);
      return { id, domain: fb.domain, constraints: fb.constraints, templateHint: fb.templateHint } satisfies HoleSpec;
    });
  }

  // Try to resolve the target node ID via tree-sitter.
  let targetNode = `${filePath}::program[0]`;
  try {
    targetNode = await resolveTargetNode(source, filePath);
  } catch {
    // Keep the default.
  }

  return {
    id: sketchId(source, filePath),
    targetNode,
    template: source,
    holes,
    specification: extractSpecification(source),
  };
}

/**
 * Use tree-sitter to parse the sketch and classify holes at the AST level.
 */
async function parseHolesWithTreeSitter(
  source: string,
  filePath: string,
  locations: readonly HoleLocation[],
): Promise<HoleSpec[]> {
  const mod = await getTreeSitter();
  const WebTreeSitter = mod.default;
  await WebTreeSitter.init();

  const parser = new WebTreeSitter();

  // Attempt to load the grammar for the detected language.
  const langHint = languageHintForExtension(filePath);
  if (langHint !== undefined) {
    try {
      const lang = await WebTreeSitter.Language.load(
        `tree-sitter-${langHint}.wasm`,
      );
      parser.setLanguage(lang);
    } catch {
      // Grammar not available — parse with default.
    }
  }

  const tree: TSTree = parser.parse(source);

  return locations.map((loc) => {
    const id = holeId(source, loc.offset);
    const node = findEnclosingNode(tree.rootNode, loc.offset, loc.offset + loc.length);

    if (node === null) {
      const fb = classifyHoleByStringContext(source, loc.offset);
      return { id, domain: fb.domain, constraints: fb.constraints, templateHint: fb.templateHint } satisfies HoleSpec;
    }

    const parent = node.parent;
    const fieldName = parent !== null ? getFieldForChild(parent, node) : null;

    const domain = classifyHoleDomain(node, fieldName);
    const constraints = gatherConstraints(node, fieldName);
    const templateHint = inferTemplateHint(domain, constraints);

    return { id, domain, constraints, templateHint } satisfies HoleSpec;
  });
}

/**
 * Walk the tree-sitter AST to find the deepest named node enclosing
 * the given byte range.  Returns `null` if no named node encloses it.
 */
function findEnclosingNode(
  node: TSSyntaxNode,
  start: number,
  end: number,
): TSSyntaxNode | null {
  let best: TSSyntaxNode | null = null;

  const walk = (n: TSSyntaxNode): void => {
    if (n.startIndex <= start && n.endIndex >= end) {
      if (n.isNamed) {
        best = n;
      }
      for (const child of n.namedChildren) {
        walk(child);
      }
    }
  };

  walk(node);
  return best;
}

/**
 * Resolve the content-addressed target node ID via tree-sitter parsing.
 */
async function resolveTargetNode(source: string, filePath: string): Promise<string> {
  const mod = await getTreeSitter();
  const WebTreeSitter = mod.default;
  await WebTreeSitter.init();

  const parser = new WebTreeSitter();
  const langHint = languageHintForExtension(filePath);
  if (langHint !== undefined) {
    try {
      const lang = await WebTreeSitter.Language.load(
        `tree-sitter-${langHint}.wasm`,
      );
      parser.setLanguage(lang);
    } catch {
      // Fall through.
    }
  }

  const tree: TSTree = parser.parse(source);
  const target = findTargetNode(tree.rootNode);
  return targetNodeId(target, filePath);
}
