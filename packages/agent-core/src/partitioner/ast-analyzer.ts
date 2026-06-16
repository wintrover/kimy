/**
 * ast-analyzer — web-tree-sitter based AST analysis for cost metrics.
 *
 * HARD CONSTRAINT: Uses web-tree-sitter WASM ONLY.
 * ❌ NEVER import from 'tree-sitter' (native addon, ABI fragmentation)
 * ❌ NEVER use relative './vendor/...' paths (CWD-dependent)
 *
 * Singleton parser pattern: lazy-init, cached in module-level variable.
 */

import { resolveTreeSitterNimWasm } from './wasm-locator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostMetrics {
  /** Total AST node count */
  nodeCount: number;
  /** Cyclomatic complexity (branch count + 1) */
  cyclomaticComplexity: number;
  /** Number of inter-file import edges */
  ioDegree: number;
  /** Weighted cost: α·(nodeCount/100) + β·CC + γ·Degree */
  weight: number;
  /** Whether parsing fell back to line-count heuristic */
  fallback: boolean;
  /** Reason for fallback, if any */
  reason?: string;
}

export interface FileAnalysis {
  filePath: string;
  metrics: CostMetrics;
  imports: string[];
}

// ---------------------------------------------------------------------------
// Branch & proc node type sets (Nim grammar via tree-sitter)
// ---------------------------------------------------------------------------

const BRANCH_NODE_TYPES = new Set([
  'if_statement',
  'elif_branch',
  'else_branch',
  'while_statement',
  'for_statement',
  'case_statement',
  'of_branch',
  'try_statement',
  'except_clause',
  'finally_clause',
  'when_statement',
]);

const PROC_NODE_TYPES = new Set([
  'proc_definition',
  'func_definition',
  'method_definition',
  'iterator_definition',
  'template_definition',
  'macro_definition',
]);

// ---------------------------------------------------------------------------
// Singleton parser (lazy init)
// ---------------------------------------------------------------------------

// web-tree-sitter is a side-effect-heavy WASM module; we type it minimally
// to avoid importing @types that may not match the exact WASM build.
interface TreeSitterNode {
  type: string;
  childCount: number;
  children: TreeSitterNode[];
  text: string;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  parse(source: string): TreeSitterTree;
}

interface TreeSitterStatic {
  Language: {
    load(wasmPath: string): Promise<unknown>;
  };
  Parser: new () => TreeSitterParser & {
    setLanguage(lang: unknown): void;
  };
}

let parserInstance: TreeSitterParser | undefined;

async function getParser(): Promise<TreeSitterParser> {
  if (parserInstance !== undefined) return parserInstance;

  const wasmPath = await resolveTreeSitterNimWasm();
  // Dynamic import for web-tree-sitter (WASM-only, no native addons)
  const mod = await import('web-tree-sitter') as unknown as TreeSitterStatic;
  const lang = await mod.Language.load(wasmPath);
  const parser = new mod.Parser();
  parser.setLanguage(lang);
  parserInstance = parser;
  return parserInstance;
}

// ---------------------------------------------------------------------------
// Fallback: line-count heuristic
// ---------------------------------------------------------------------------

function fallbackCostMetrics(sourceCode: string, reason: string): CostMetrics {
  const lineCount = sourceCode.split('\n').length;
  return {
    nodeCount: lineCount,
    cyclomaticComplexity: 1,
    ioDegree: 0,
    weight: lineCount / 100,
    fallback: true,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Parse error detection
// ---------------------------------------------------------------------------

/**
 * Recursively check if any node in the tree is an ERROR node.
 * Parse errors in tree-sitter surface as ERROR nodes in the concrete syntax tree.
 */
export function hasParseError(node: TreeSitterNode): boolean {
  if (node.type === 'ERROR') return true;
  for (const child of node.children) {
    if (hasParseError(child)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cyclomatic complexity
// ---------------------------------------------------------------------------

/**
 * Compute cyclomatic complexity by counting branch nodes.
 * CC = count(branch nodes) + 1
 */
export function computeCyclomaticComplexity(rootNode: TreeSitterNode): number {
  let count = 0;
  function walk(node: TreeSitterNode): void {
    if (BRANCH_NODE_TYPES.has(node.type)) {
      count++;
    }
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(rootNode);
  return count + 1;
}

// ---------------------------------------------------------------------------
// Import detection
// ---------------------------------------------------------------------------

/**
 * Extract import target module names from import/from_import AST nodes.
 * Returns a list of module path strings (e.g., "std/strutils", "foo/bar").
 */
export function detectImports(rootNode: TreeSitterNode): string[] {
  const imports: string[] = [];

  function walk(node: TreeSitterNode): void {
    if (node.type === 'import' || node.type === 'from_import') {
      // Extract the module path from the first child that looks like an identifier chain
      const modulePath = extractModulePath(node);
      if (modulePath !== undefined && modulePath !== '') {
        imports.push(modulePath);
      }
    }
    // Also handle dotted imports within import statements
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(rootNode);
  return imports;
}

/**
 * Extract the module path string from an import or from_import node.
 * Handles patterns like: `import std/strutils` or `from std/strutils import ...`
 */
function extractModulePath(node: TreeSitterNode): string | undefined {
  // Walk children to find the module identifier chain
  for (const child of node.children) {
    if (child.type === 'dotted_identifier' || child.type === 'identifier') {
      return child.text;
    }
    // Recurse one level for compound nodes
    if (child.type !== 'import' && child.type !== 'from_import') {
      const nested = extractModulePath(child);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Node counting
// ---------------------------------------------------------------------------

function countNodes(node: TreeSitterNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a single source file's AST and compute cost metrics.
 *
 * @param sourceCode — the raw source text
 * @param filePath   — path to the file (used as identifier in results)
 * @returns FileAnalysis with metrics and import list
 */
export async function analyzeSourceCode(
  sourceCode: string,
  filePath: string,
): Promise<FileAnalysis> {
  let parser: TreeSitterParser;
  try {
    parser = await getParser();
  } catch (cause) {
    // WASM unavailable — fall back to line-count heuristic
    const metrics = fallbackCostMetrics(
      sourceCode,
      `Parser init failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return { filePath, metrics, imports: [] };
  }

  let tree: TreeSitterTree;
  try {
    tree = parser.parse(sourceCode);
  } catch (cause) {
    const metrics = fallbackCostMetrics(
      sourceCode,
      `Parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return { filePath, metrics, imports: [] };
  }

  const rootNode = tree.rootNode;

  // Detect parse errors → fallback
  if (hasParseError(rootNode)) {
    const metrics = fallbackCostMetrics(sourceCode, 'AST contains ERROR nodes (parse error)');
    return { filePath, metrics, imports: [] };
  }

  const nodeCount = countNodes(rootNode);
  const cyclomaticComplexity = computeCyclomaticComplexity(rootNode);
  const imports = detectImports(rootNode);

  return {
    filePath,
    metrics: {
      nodeCount,
      cyclomaticComplexity,
      ioDegree: 0, // Will be populated by dependency-graph.ts
      weight: nodeCount / 100, // Baseline; recomputed with full metrics later
      fallback: false,
    },
    imports,
  };
}

/**
 * Analyze multiple source files and return an array of FileAnalyses.
 *
 * @param files — array of { path, content } objects
 * @returns FileAnalysis array, one per file
 */
export async function analyzeSourceFiles(
  files: { path: string; content: string }[],
): Promise<FileAnalysis[]> {
  const results: FileAnalysis[] = [];
  for (const file of files) {
    const analysis = await analyzeSourceCode(file.content, file.path);
    results.push(analysis);
  }
  return results;
}
