/**
 * Sketch Assembly Engine for AgentSwarm Sketch-Based Algebraic Synthesis.
 *
 * Takes a sketch template (source with holes marked as `??`) and a
 * `SynthesisResult` that maps each hole to a synthesised value, then:
 *
 *   1. Produces a fully-assembled source string with all holes filled.
 *   2. Validates the assembled source parses without errors (tree-sitter).
 *   3. Generates `StructuralASTMutation[]` that can apply the same
 *      substitutions to the **original** source via content-addressed node IDs.
 *
 * The assembler is deliberately stateless and synchronous where possible;
 * tree-sitter validation is async because of the dynamic WASM import.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { StructuralASTMutation } from '#/tools/builtin/file/structural-mutation';

// ---------------------------------------------------------------------------
// Public types — Sketch, Hole, SynthesisResult
// ---------------------------------------------------------------------------

/**
 * Describes a single unknown sub-expression ("hole") inside a sketch.
 *
 * - `id`: Stable identifier for the hole (used as key in `SynthesisResult`).
 * - `placeholder`: The literal token in the sketch source that marks this
 *   hole. Defaults to `'??'` but can be a labelled variant like `??<hint>`.
 * - `node_id`: Content-addressed identifier of the **original** AST node
 *   that this hole replaces. Enables mutation against the original source.
 * - `expectedType`: Optional type constraint for the hole (informational;
 *   the synthesizer should respect it but the assembler does not enforce it).
 * - `context`: Optional free-text context that helped locate this hole
 *   (e.g. "return value of `fetch()`").
 */
export interface HoleInfo {
  readonly id: string;
  readonly placeholder: string;
  readonly node_id: string;
  readonly expectedType?: string;
  readonly context?: string;
}

/**
 * A sketch is a version of the original source where selected
 * sub-expressions have been replaced by placeholder tokens (`??`).
 *
 * - `template`: The sketched source text with holes in place of the
 *   original sub-expressions.
 * - `holes`: Metadata for every hole in the template, ordered by their
 *   first occurrence in `template`.
 * - `originalSource`: The unmodified source the sketch was derived from.
 * - `filePath`: File path used for language detection (needed by
 *   `StructuralASTMutation` and tree-sitter parsing).
 * - `language`: Optional language hint override (e.g. `'typescript'`).
 */
export interface Sketch {
  readonly template: string;
  readonly holes: readonly HoleInfo[];
  readonly originalSource: string;
  readonly filePath: string;
  readonly language?: string;
}

/**
 * The output of a synthesis pass.  Maps each hole ID to the value
 * that should fill it.
 */
export interface SynthesisResult {
  readonly holeValues: ReadonlyMap<string, string>;
}

/**
 * Full result of assembling a sketch with synthesised values.
 */
export interface AssembledResult {
  /** Fully assembled source — all holes replaced with their synthesised values. */
  readonly completeSource: string;
  /** Mutations that produce the same result when applied to the original source. */
  readonly appliedMutations: StructuralASTMutation[];
  /** Hole ID → final inserted value (may differ from holeValues if sanitised). */
  readonly sourceMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Zod schemas (exported for downstream validation)
// ---------------------------------------------------------------------------

export const HoleInfoSchema = z.object({
  id: z.string().min(1),
  placeholder: z.string().min(1),
  node_id: z.string().min(1),
  expectedType: z.string().optional(),
  context: z.string().optional(),
});

export const SketchSchema = z.object({
  template: z.string(),
  holes: z.array(HoleInfoSchema),
  originalSource: z.string(),
  filePath: z.string().min(1),
  language: z.string().optional(),
});

export const SynthesisResultSchema = z.object({
  holeValues: z.map(z.string(), z.string()),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when assembly fails validation or encounters inconsistent inputs.
 */
export class SketchAssemblyError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Sketch assembly failed: ${reasons.join('; ')}`);
    this.name = 'SketchAssemblyError';
    this.reasons = reasons;
  }
}

/**
 * Thrown when the assembled source fails tree-sitter parse validation.
 */
export class SketchValidationError extends SketchAssemblyError {
  readonly assembledSource: string;
  readonly parseErrors: readonly string[];

  constructor(assembledSource: string, parseErrors: readonly string[]) {
    super([
      'Assembled source failed syntax validation:',
      ...parseErrors,
    ]);
    this.name = 'SketchValidationError';
    this.assembledSource = assembledSource;
    this.parseErrors = parseErrors;
  }
}

// ---------------------------------------------------------------------------
// Content-Addressed Node ID hashing
// ---------------------------------------------------------------------------

/**
 * Compute a content-addressed identifier for source text.
 *
 * Uses SHA-256 truncated to 16 hex characters, matching the scheme used
 * by `structural-mutation.ts`.
 */
function hashNodeId(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

/** Default placeholder token used for sketch holes. */
const DEFAULT_PLACEHOLDER = '??';

/**
 * Build a regex that matches a labelled placeholder like `??<hint>`.
 * The hint is captured but not consumed — it stays in the source as-is.
 */
function buildPlaceholderRegex(placeholder: string): RegExp {
  // Escape regex-special characters in the placeholder.
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the placeholder optionally followed by a `<label>` hint.
  return new RegExp(`${escaped}(?:<[^>]+>)?`, 'g');
}

// ---------------------------------------------------------------------------
// Core assembly logic
// ---------------------------------------------------------------------------

/**
 * Replace placeholder tokens in `template` with synthesised values and
 * build the corresponding mutations against the original source.
 *
 * Steps:
 *   1. Iterate holes in template order and replace each placeholder with
 *      the synthesised value from `synthesisResult.holeValues`.
 *   2. For each hole, look up the `node_id` to identify the node in the
 *      **original** source that needs to be replaced.
 *   3. Build a `StructuralASTMutation` per hole so that the same
 *      substitution can be replayed on the original source.
 *   4. Validate the assembled source parses cleanly (tree-sitter).
 */
export async function assembleSketch(
  sketch: Sketch,
  synthesisResult: SynthesisResult,
  originalSource: string,
): Promise<AssembledResult> {
  const { template, holes, filePath } = sketch;

  // --- 1. Validate inputs ------------------------------------------------
  const reasons: string[] = [];
  if (holes.length === 0) {
    reasons.push('Sketch contains no holes — nothing to assemble.');
  }
  if (originalSource.length === 0) {
    reasons.push('Original source is empty.');
  }

  // Check that every hole has a synthesis value.
  const missingHoles: string[] = [];
  for (const hole of holes) {
    if (!synthesisResult.holeValues.has(hole.id)) {
      missingHoles.push(hole.id);
    }
  }
  if (missingHoles.length > 0) {
    reasons.push(
      `Missing synthesis values for holes: ${missingHoles.join(', ')}`,
    );
  }

  // Check that synthesisResult doesn't contain values for unknown holes.
  const holeIdSet = new Set(holes.map((h) => h.id));
  const extraHoles: string[] = [];
  for (const id of synthesisResult.holeValues.keys()) {
    if (!holeIdSet.has(id)) {
      extraHoles.push(id);
    }
  }
  if (extraHoles.length > 0) {
    reasons.push(
      `SynthesisResult contains values for unknown holes: ${extraHoles.join(', ')}`,
    );
  }

  if (reasons.length > 0) {
    throw new SketchAssemblyError(reasons);
  }

  // --- 2. Replace placeholders in template --------------------------------
  const sourceMap = new Map<string, string>();
  const mutations: StructuralASTMutation[] = [];
  let assembledSource = template;

  // Process holes in reverse order of their first occurrence so that
  // replacement offsets don't invalidate earlier positions.
  const holesWithPosition = holes.map((hole, index) => {
    const regex = buildPlaceholderRegex(hole.placeholder);
    const match = regex.exec(assembledSource);
    return { hole, index, offset: match?.index ?? -1 };
  });

  // Sort by descending offset for safe reverse-order replacement.
  const sortedHoles = holesWithPosition
    .filter((h) => h.offset >= 0)
    .sort((a, b) => b.offset - a.offset);

  for (const { hole } of sortedHoles) {
    const value = synthesisResult.holeValues.get(hole.id)!;

    // Find the first occurrence of this hole's placeholder in the
    // current (progressively modified) assembled source.
    const regex = buildPlaceholderRegex(hole.placeholder);
    const match = regex.exec(assembledSource);
    if (match === null) {
      // Placeholder may have been consumed by a previous replacement
      // or was never present — skip gracefully.
      continue;
    }

    // Replace the placeholder (and optional trailing label) with the value.
    const before = assembledSource.slice(0, match.index);
    const after = assembledSource.slice(match.index + match[0].length);
    assembledSource = before + value + after;

    sourceMap.set(hole.id, value);

    // Build the StructuralASTMutation for the original source.
    // The node_id targets the node in the original AST that the hole
    // replaces; the replacement is the synthesised value.
    mutations.push({
      node_id: hole.node_id,
      replacement: value,
      operation: 'replace',
    });
  }

  // --- 3. Validate assembled source via tree-sitter -----------------------
  const parseErrors = await validateSyntax(assembledSource, filePath);
  if (parseErrors.length > 0) {
    throw new SketchValidationError(assembledSource, parseErrors);
  }

  // --- 4. Return ----------------------------------------------------------
  // Reverse mutations to restore hole-insertion order (ascending offset
  // on the original source, which is the typical consumer expectation).
  mutations.reverse();

  return {
    completeSource: assembledSource,
    appliedMutations: mutations,
    sourceMap,
  };
}

// ---------------------------------------------------------------------------
// Tree-sitter syntax validation (lazy WASM import)
// ---------------------------------------------------------------------------

// Re-use the same lazy-loading pattern as structural-mutation.ts.
let _treeSitterPromise: Promise<unknown> | undefined;

async function getTreeSitter(): Promise<unknown> {
  if (_treeSitterPromise === undefined) {
    _treeSitterPromise = import('web-tree-sitter');
  }
  return _treeSitterPromise;
}

/** Minimal tree-sitter node contract for error checking. */
interface TSErrorNode {
  readonly text: string;
  readonly hasError: boolean;
  readonly hasChildren: boolean;
  child(index: number): TSErrorNode | null;
}

interface TSErrorTree {
  readonly rootNode: TSErrorNode;
}

interface TSErrorParser {
  parse(source: string): TSErrorTree;
}

/**
 * Walk the tree-sitter tree and collect all nodes marked as errors.
 * Returns an array of human-readable error descriptions.
 */
function collectParseErrors(node: TSErrorNode, source: string): string[] {
  const errors: string[] = [];
  const walk = (n: TSErrorNode, depth: number): void => {
    if (n.hasError) {
      const preview = n.text.length > 80 ? n.text.slice(0, 80) + '…' : n.text;
      errors.push(`parse error at depth ${String(depth)}: "${preview}"`);
    }
    if (n.hasChildren) {
      for (let i = 0; ; i++) {
        const child = n.child(i);
        if (child === null) break;
        walk(child, depth + 1);
      }
    }
  };
  walk(node, 0);
  return errors;
}

/**
 * Validate that `source` parses without syntax errors using tree-sitter.
 *
 * Returns an empty array if the parse is clean, or an array of error
 * descriptions otherwise.  When tree-sitter is unavailable the function
 * returns an empty array (best-effort validation).
 */
async function validateSyntax(
  source: string,
  filePath: string,
): Promise<readonly string[]> {
  // Determine language hint from file extension.
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'unknown' || ext === '') {
    // Cannot validate unknown languages — skip.
    return [];
  }

  let WebTreeSitter: unknown;
  try {
    const mod = (await getTreeSitter()) as { default?: unknown };
    WebTreeSitter = mod.default ?? mod;
  } catch {
    // tree-sitter not installed — skip validation gracefully.
    return [];
  }

  const initFn = (WebTreeSitter as { init?: () => Promise<void> }).init;
  if (typeof initFn === 'function') {
    await initFn.call(WebTreeSitter);
  }

  const ParserCtor = WebTreeSitter as new () => TSErrorParser;
  const parser = new ParserCtor();
  const tree = parser.parse(source);

  return collectParseErrors(tree.rootNode, source);
}

// ---------------------------------------------------------------------------
// Convenience: direct replacement without tree-sitter validation
// ---------------------------------------------------------------------------

/**
 * Fill holes in a sketch template **without** tree-sitter validation.
 *
 * Use this when you only need the assembled text (e.g. for display or
 * further processing) and don't want the async WASM overhead.
 *
 * @throws {SketchAssemblyError} on missing holes or input inconsistencies.
 */
export function assembleSketchUnsafe(
  sketch: Sketch,
  synthesisResult: SynthesisResult,
): { completeSource: string; sourceMap: Map<string, string> } {
  const { template, holes } = sketch;

  const reasons: string[] = [];
  if (holes.length === 0) {
    reasons.push('Sketch contains no holes — nothing to assemble.');
  }

  const missingHoles: string[] = [];
  for (const hole of holes) {
    if (!synthesisResult.holeValues.has(hole.id)) {
      missingHoles.push(hole.id);
    }
  }
  if (missingHoles.length > 0) {
    reasons.push(
      `Missing synthesis values for holes: ${missingHoles.join(', ')}`,
    );
  }

  if (reasons.length > 0) {
    throw new SketchAssemblyError(reasons);
  }

  const sourceMap = new Map<string, string>();
  let assembledSource = template;

  // Build position-aware hole list.
  const holesWithPosition = holes.map((hole) => {
    const regex = buildPlaceholderRegex(hole.placeholder);
    const match = regex.exec(assembledSource);
    return { hole, offset: match?.index ?? -1 };
  });

  // Replace in reverse offset order.
  const sortedHoles = holesWithPosition
    .filter((h) => h.offset >= 0)
    .sort((a, b) => b.offset - a.offset);

  for (const { hole } of sortedHoles) {
    const value = synthesisResult.holeValues.get(hole.id)!;
    const regex = buildPlaceholderRegex(hole.placeholder);
    const match = regex.exec(assembledSource);
    if (match === null) continue;

    const before = assembledSource.slice(0, match.index);
    const after = assembledSource.slice(match.index + match[0].length);
    assembledSource = before + value + after;
    sourceMap.set(hole.id, value);
  }

  return { completeSource: assembledSource, sourceMap };
}

// ---------------------------------------------------------------------------
// Mutation-only helper
// ---------------------------------------------------------------------------

/**
 * Generate `StructuralASTMutation[]` from a sketch and synthesis result
 * without assembling the source.  Useful when you only need the mutation
 * plan to apply against the original file via `applyStructuralMutations`.
 *
 * @throws {SketchAssemblyError} on missing holes or input inconsistencies.
 */
export function buildMutationsFromSketch(
  sketch: Sketch,
  synthesisResult: SynthesisResult,
): StructuralASTMutation[] {
  const { holes } = sketch;

  const missingHoles: string[] = [];
  for (const hole of holes) {
    if (!synthesisResult.holeValues.has(hole.id)) {
      missingHoles.push(hole.id);
    }
  }
  if (missingHoles.length > 0) {
    throw new SketchAssemblyError([
      `Missing synthesis values for holes: ${missingHoles.join(', ')}`,
    ]);
  }

  return holes.map((hole) => ({
    node_id: hole.node_id,
    replacement: synthesisResult.holeValues.get(hole.id)!,
    operation: 'replace' as const,
  }));
}
