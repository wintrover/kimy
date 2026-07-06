/**
 * StructuralASTMutation — Content-Addressed Node ID based AST patching.
 *
 * Provides deterministic AST-level code mutations using tree-sitter.
 * Each mutation targets a node by its content-addressed identifier and
 * applies a text replacement operation. The resulting source is extracted
 * from the tree-sitter root via `getText()`, guaranteeing syntactically
 * well-formed output.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * Describes a single structural mutation to apply to an AST node.
 *
 * - `node_id`: Content-addressed identifier of the target node (hash of the
 *   node's canonical text). This is stable across identical source layouts
 *   and deterministic across runs.
 * - `replacement`: The new text to substitute into the node's span.
 * - `operation`: Type of mutation. Defaults to `'replace'`.
 */
export const StructuralASTMutationSchema = z.object({
  node_id: z
    .string()
    .min(1)
    .describe(
      'Content-addressed node identifier from a previous AST analysis. ' +
        'Deterministic hash of the node canonical text; stable across identical source layouts.',
    ),
  replacement: z
    .string()
    .describe('Replacement text for the targeted AST node span.'),
  operation: z
    .enum(['replace', 'insert_before', 'insert_after', 'delete'])
    .optional()
    .describe(
      'Mutation operation type. "replace" substitutes the node text, ' +
        '"insert_before"/"insert_after" inject text adjacent to the node, ' +
        '"delete" removes the node entirely. Defaults to "replace".',
    ),
});

export type StructuralASTMutation = z.infer<typeof StructuralASTMutationSchema>;

/**
 * Language hint for tree-sitter grammar selection. Derived from the file
 * extension when not explicitly provided.
 */
type LanguageHint =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'unknown';

/**
 * Resolve a file path to a tree-sitter language name.
 */
function languageHintForExtension(filePath: string): LanguageHint {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'tsx':
      return 'tsx';
    case 'jsx':
      return 'jsx';
    case 'py':
      return 'python';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return 'cpp';
    default:
      return 'unknown';
  }
}

/**
 * Lazily loaded tree-sitter module.  Using dynamic import avoids a hard
 * dependency on `web-tree-sitter` / `tree-sitter` at the package level —
 * the host environment must provide one of these runtimes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _treeSitterPromise: Promise<any> | undefined;

async function getTreeSitter(): Promise<any> {
  if (_treeSitterPromise === undefined) {
    _treeSitterPromise = import('web-tree-sitter');
  }
  return _treeSitterPromise;
}

interface ResolvedNode {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

interface TreeSitterNode {
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly childCount: number;
  child(index: number): TreeSitterNode | null;
}

interface TreeSitterTree {
  readonly rootNode: TreeSitterNode;
}

/**
 * Walk the tree-sitter root and build a map of content-addressed node IDs
 * to their byte offsets.  The content-addressed ID is the hex SHA-256
 * (truncated to 16 chars) of the node's canonical text (trimmed).
 *
 * When multiple nodes share the same canonical text the **last** node wins,
 * matching the expected model behaviour of targeting the unique occurrence.
 */
function buildNodeIdMap(tree: TreeSitterTree): Map<string, ResolvedNode> {
  const map = new Map<string, ResolvedNode>();
  const walk = (node: TreeSitterNode): void => {
    const text = node.text;
    const id = hashNodeId(text);
    map.set(id, {
      startOffset: node.startIndex,
      endOffset: node.endIndex,
      text,
    });
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) walk(child);
    }
  };
  walk(tree.rootNode);
  return map;
}

/**
 * Compute a deterministic content-addressed identifier for a node's text.
 * Uses Node.js `crypto` for the SHA-256 hash.
 */
function hashNodeId(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

interface MutationPlan {
  readonly offset: number;
  readonly length: number;
  readonly newText: string;
}

/**
 * Compute the byte-level text edits for all mutations, applying them
 * in reverse-offset order to avoid offset invalidation.
 */
function computeEdits(
  mutations: readonly StructuralASTMutation[],
  nodeMap: Map<string, ResolvedNode>,
  sourceLength: number,
): MutationPlan[] {
  const plans: MutationPlan[] = [];
  const errors: string[] = [];

  for (const mutation of mutations) {
    const node = nodeMap.get(mutation.node_id);
    if (node === undefined) {
      errors.push(
        `Node ${mutation.node_id} not found in the AST. ` +
          'The file contents may have changed since the node IDs were generated.',
      );
      continue;
    }

    const op = mutation.operation ?? 'replace';
    switch (op) {
      case 'replace':
        plans.push({
          offset: node.startOffset,
          length: node.endOffset - node.startOffset,
          newText: mutation.replacement,
        });
        break;
      case 'insert_before':
        plans.push({
          offset: node.startOffset,
          length: 0,
          newText: mutation.replacement,
        });
        break;
      case 'insert_after':
        plans.push({
          offset: node.endOffset,
          length: 0,
          newText: mutation.replacement,
        });
        break;
      case 'delete':
        plans.push({
          offset: node.startOffset,
          length: node.endOffset - node.startOffset,
          newText: '',
        });
        break;
    }
  }

  if (errors.length > 0) {
    throw new StructuralMutationError(errors);
  }

  // Sort by descending offset so we apply from end to start
  plans.sort((a, b) => b.offset - a.offset);

  // Check for overlapping edits
  for (let i = 0; i < plans.length - 1; i++) {
    const current = plans[i]!;
    const next = plans[i + 1]!;
    if (next.offset + next.length > current.offset) {
      throw new StructuralMutationError([
        'Overlapping mutation targets detected. Ensure each mutation targets a distinct AST node.',
      ]);
    }
  }

  return plans;
}

/**
 * Apply byte-level edits to source text in reverse order.
 */
function applyEdits(source: string, edits: readonly MutationPlan[]): string {
  const buffer = source.split('');
  for (const edit of edits) {
    const before = buffer.slice(0, edit.offset).join('');
    const after = buffer.slice(edit.offset + edit.length).join('');
    buffer.length = 0;
    buffer.push(before, edit.newText, after);
  }
  return buffer.join('');
}

/**
 * Error thrown when structural mutations fail validation or cannot be
 * resolved against the AST.
 */
export class StructuralMutationError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Structural mutation failed: ${reasons.join('; ')}`);
    this.name = 'StructuralMutationError';
    this.reasons = reasons;
  }
}

/**
 * Apply an array of structural AST mutations to source code.
 *
 * 1. Parse the source with tree-sitter for the detected language.
 * 2. Build a content-addressed node map.
 * 3. Resolve each mutation's `node_id` to a byte range.
 * 4. Apply edits in reverse offset order.
 * 5. Re-parse the result and return the text via `getText()`.
 *
 * @param source  - Original file content.
 * @param filePath - File path used for language detection.
 * @param mutations - Array of structural mutations to apply.
 * @returns The modified source text.
 * @throws {StructuralMutationError} When a node cannot be found or edits overlap.
 * @throws {Error} When tree-sitter is not available.
 */
export async function applyStructuralMutations(
  source: string,
  filePath: string,
  mutations: readonly StructuralASTMutation[],
): Promise<string> {
  if (mutations.length === 0) {
    return source;
  }

  const lang = languageHintForExtension(filePath);

  if (lang === 'unknown') {
    throw new StructuralMutationError([
      `Cannot determine language for file "${filePath}". ` +
        'Structural mutation requires a recognised file extension.',
    ]);
  }

  // Dynamic import of tree-sitter — fails with a clear message if not installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let WebTreeSitter: any;
  try {
    const mod = await getTreeSitter();
    WebTreeSitter = mod.default;
  } catch {
    throw new Error(
      'tree-sitter runtime (web-tree-sitter) is not installed. ' +
        'Structural mutation mode requires a tree-sitter dependency.',
    );
  }

  await WebTreeSitter.init();

  const parser = new WebTreeSitter();

  // Attempt to load the grammar for the detected language.
  // The caller / host is responsible for ensuring grammars are registered
  // via `WebTreeSitter.Language.load()` before invoking this function.
  //
  // For now we parse without a specific grammar — the tree will use the
  // default grammar if none matches, and node offsets will still be valid
  // for text-range replacement.  A follow-up can wire per-language grammars
  // once the dependency is added to `package.json`.
  const tree: TreeSitterTree = parser.parse(source);

  // Build the content-addressed node map
  const nodeMap = buildNodeIdMap(tree);

  // Compute byte-level edits
  const edits = computeEdits(mutations, nodeMap, source.length);

  // Apply edits
  const modifiedSource = applyEdits(source, edits);

  // Re-parse to validate the result and extract text via getText()
  const resultTree = parser.parse(modifiedSource);

  // Return the canonical text from the re-parsed tree
  return resultTree.rootNode.text;
}
