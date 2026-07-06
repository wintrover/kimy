/**
 * Content-Addressed AST Node ID generator for Nim source files.
 *
 * Parses Nim source using tree-sitter WASM and generates stable,
 * coordinate-drift-proof node identifiers based on structural paths.
 *
 * NodeID format: `file_path::structural_path#node_type`
 * Example: `z3_solver_wrapper.nim::module.declarations[3]#function_definition`
 *
 * Structural paths encode the AST hierarchy (field names + child indices)
 * without any byte or line coordinates, making them resilient to edits
 * that shift positions but preserve structure.
 *
 * Incremental parsing is supported: call `tree.edit(edit)` on a previous
 * tree, then pass it to `parseFile` via the `oldTree` option so that
 * tree-sitter can reuse unchanged subtrees.
 */

import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Minimal tree-sitter type contracts (web-tree-sitter compatible)
// ---------------------------------------------------------------------------

/** A point in the source expressed as (row, column). */
export interface TSPoint {
  readonly row: number;
  readonly column: number;
}

/** An edit range used by `tree.edit()` for incremental re-parsing. */
export interface TSEdit {
  readonly startIndex: number;
  readonly oldEndIndex: number;
  readonly newEndIndex: number;
  readonly startPosition: TSPoint;
  readonly oldEndPosition: TSPoint;
  readonly newEndPosition: TSPoint;
}

/** A single node in the concrete syntax tree. */
export interface TSSyntaxNode {
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
export interface TSTree {
  readonly rootNode: TSSyntaxNode;
  edit(edit: TSEdit): void;
}

/** The parser interface exposed to this module. */
export interface TSParser {
  parse(source: string, oldTree?: TSTree): TSTree;
  setLanguage(language: unknown): void;
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface ParseFileResult {
  readonly tree: TSTree;
  readonly nodeMap: ReadonlyMap<string, TSSyntaxNode>;
}

// ---------------------------------------------------------------------------
// Module state — lazy WASM initialisation
// ---------------------------------------------------------------------------

let _parser: TSParser | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Path to the Nim grammar WASM file produced by tree-sitter.
 * Override via {@link configureWasmPaths} before the first parse call.
 */
export let NIM_GRAMMAR_WASM_PATH = 'node_modules/tree-sitter-nim/tree-sitter-nim.wasm';

/**
 * Override the default WASM file locations.
 * Must be called before the first `parseFile` invocation.
 */
export function configureWasmPaths(options: {
  nimGrammarWasm?: string;
}): void {
  if (options.nimGrammarWasm !== undefined) {
    NIM_GRAMMAR_WASM_PATH = options.nimGrammarWasm;
  }
}

async function ensureParser(): Promise<TSParser> {
  if (_parser !== null) return _parser;

  if (_initPromise === null) {
    _initPromise = (async () => {
      // Dynamic import keeps the module loadable even when web-tree-sitter
      // has not been installed yet (e.g. during type-checking only).
      const { default: Parser } = await import('web-tree-sitter');
      await Parser.init();
      const NimLang = await Parser.Language.load(NIM_GRAMMAR_WASM_PATH);
      const parser = new Parser();
      parser.setLanguage(NimLang);
      _parser = parser as unknown as TSParser;
    })();
  }

  await _initPromise;
  return _parser!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Nim source file and return the AST tree plus a bidirectional
 * node map (NodeID → SyntaxNode).
 *
 * For incremental parsing, pass the previous `tree` (after calling
 * `tree.edit(...)`) and the updated `source` string:
 *
 * ```ts
 * const first = await parseFile('foo.nim');
 * // ... file is edited ...
 * first.tree.edit({ startIndex: 42, oldEndIndex: 42, newEndIndex: 50, ... });
 * const second = await parseFile('foo.nim', { source: newSource, oldTree: first.tree });
 * ```
 *
 * @param filePath  Absolute or relative path to the `.nim` file.
 * @param options   Optional: supply pre-read source text and/or an old
 *                  tree for incremental re-parsing.
 */
export async function parseFile(
  filePath: string,
  options?: {
    source?: string;
    oldTree?: TSTree;
  },
): Promise<ParseFileResult> {
  const parser = await ensureParser();
  const source = options?.source ?? (await readFile(filePath, 'utf-8'));
  const tree = options?.oldTree !== undefined
    ? parser.parse(source, options.oldTree)
    : parser.parse(source);

  const nodeMap = buildNodeMap(tree.rootNode, filePath);
  return { tree, nodeMap };
}

/**
 * Generate a Content-Addressed NodeID for an AST node.
 *
 * The ID format is `filePath::structuralPath#nodeType`.
 * Structural paths use only field names and child indices — never byte
 * or line coordinates — so the ID stays stable as long as the AST
 * structure is unchanged.
 */
export function getNodeId(node: TSSyntaxNode, filePath: string): string {
  const root = findRoot(node);
  const structuralPath = computeStructuralPath(node, root);
  return `${filePath}::${structuralPath}#${node.type}`;
}

/**
 * Find a `SyntaxNode` inside `tree` by its NodeID string.
 *
 * Returns `null` when the structural path does not resolve to any node
 * in the current tree (e.g. after an edit changed the structure).
 */
export function findNodeById(tree: TSTree, nodeId: string): TSSyntaxNode | null {
  const separatorIdx = nodeId.indexOf('::');
  if (separatorIdx === -1) return null;

  const rest = nodeId.slice(separatorIdx + 2);
  const hashIdx = rest.lastIndexOf('#');
  if (hashIdx === -1) return null;

  const structuralPath = rest.slice(0, hashIdx);
  return walkToPath(tree.rootNode, structuralPath);
}

// ---------------------------------------------------------------------------
// Internal helpers — structural path computation
// ---------------------------------------------------------------------------

/** Walk up to the root of the tree. */
function findRoot(node: TSSyntaxNode): TSSyntaxNode {
  let current: TSSyntaxNode = node;
  while (current.parent !== null) {
    current = current.parent;
  }
  return current;
}

/**
 * Return the grammar field name that `parent` assigns to `child`,
 * or `null` when the child sits in an unlabelled position.
 */
function getFieldForChild(parent: TSSyntaxNode, child: TSSyntaxNode): string | null {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c !== null && c.id === child.id) {
      return parent.fieldNameForChild(i);
    }
  }
  return null;
}

/**
 * Compute a structural path from `root` down to `node`.
 *
 * Format: `rootType.field[index].field[index]...`
 *
 * Labels use the grammar field name when available; otherwise they fall
 * back to the node type.  Indices are scoped to siblings that share the
 * same label, ensuring deterministic uniqueness within a single tree.
 */
function computeStructuralPath(node: TSSyntaxNode, root: TSSyntaxNode): string {
  if (node.id === root.id) return root.type;

  const segments: string[] = [root.type];
  let current: TSSyntaxNode = node;

  while (current.id !== root.id) {
    const parent = current.parent;
    if (parent === null) break;

    const fieldName = getFieldForChild(parent, current);
    const namedChildren = parent.namedChildren;

    if (fieldName !== null) {
      // Index among siblings sharing the same field name.
      let index = 0;
      for (const child of namedChildren) {
        if (getFieldForChild(parent, child) === fieldName) {
          if (child.id === current.id) break;
          index++;
        }
      }
      segments.push(`${fieldName}[${String(index)}]`);
    } else {
      // Index among unlabelled siblings of the same type.
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

/**
 * Walk from `root` downward following a structural path string.
 * Returns the matching node, or `null` when the path is invalid.
 */
function walkToPath(root: TSSyntaxNode, structuralPath: string): TSSyntaxNode | null {
  const segments = structuralPath.split('.');
  if (segments.length === 0 || segments[0] !== root.type) return null;

  let current: TSSyntaxNode = root;

  for (let i = 1; i < segments.length; i++) {
    const match = segments[i]!.match(/^([^\[]+)\[(\d+)\]$/);
    if (match === null) return null;

    const label = match[1]!;
    const targetIndex = Number(match[2]);
    const namedChildren = current.namedChildren;

    // --- Pass 1: try matching by field name --------------------------------
    let matchCount = 0;
    let found: TSSyntaxNode | null = null;
    for (const child of namedChildren) {
      if (getFieldForChild(current, child) === label) {
        if (matchCount === targetIndex) {
          found = child;
          break;
        }
        matchCount++;
      }
    }

    // --- Pass 2: try matching by type (unlabelled children only) -----------
    if (found === null) {
      matchCount = 0;
      for (const child of namedChildren) {
        if (getFieldForChild(current, child) === null && child.type === label) {
          if (matchCount === targetIndex) {
            found = child;
            break;
          }
          matchCount++;
        }
      }
    }

    if (found === null) return null;
    current = found;
  }

  return current;
}

// ---------------------------------------------------------------------------
// Internal helpers — node map construction
// ---------------------------------------------------------------------------

/**
 * Recursively walk the AST and build a `Map<NodeID, SyntaxNode>` that
 * contains every named node in the tree.
 */
function buildNodeMap(root: TSSyntaxNode, filePath: string): Map<string, TSSyntaxNode> {
  const map = new Map<string, TSSyntaxNode>();
  collectNodes(root, root, filePath, map);
  return map;
}

function collectNodes(
  node: TSSyntaxNode,
  root: TSSyntaxNode,
  filePath: string,
  map: Map<string, TSSyntaxNode>,
): void {
  if (node.isNamed) {
    const id = `${filePath}::${computeStructuralPath(node, root)}#${node.type}`;
    map.set(id, node);
  }
  for (const child of node.namedChildren) {
    collectNodes(child, root, filePath, map);
  }
}
