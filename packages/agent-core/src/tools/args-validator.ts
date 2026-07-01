import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { z } from 'zod';

import type { ValidationError } from '../loop/types';

const DRAFT_07_AJV = new Ajv({ strict: false, allErrors: true });
addFormats(DRAFT_07_AJV);

const DRAFT_2019_AJV = new Ajv2019({ strict: false, allErrors: true });
addFormats(DRAFT_2019_AJV);

const DRAFT_2020_AJV = new Ajv2020({ strict: false, allErrors: true });
addFormats(DRAFT_2020_AJV);

const DRAFT_2019_KEYWORDS = new Set([
  'dependentRequired',
  'dependentSchemas',
  'maxContains',
  'minContains',
  'unevaluatedItems',
  'unevaluatedProperties',
  '$recursiveAnchor',
  '$recursiveRef',
]);

const DRAFT_2020_KEYWORDS = new Set(['prefixItems', '$dynamicAnchor', '$dynamicRef']);

// Mixing JSON Schema dialects in a single Ajv instance is unsafe because
// keyword semantics differ, e.g. draft-07 tuple `items` vs 2020-12 `prefixItems`.
function ajvFor(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const $schema = schema['$schema'];
  if (typeof $schema === 'string') {
    if ($schema.includes('2020-12')) return DRAFT_2020_AJV;
    if ($schema.includes('2019-09')) return DRAFT_2019_AJV;
    return DRAFT_07_AJV;
  }
  if (containsSchemaKeyword(schema, DRAFT_2020_KEYWORDS)) return DRAFT_2020_AJV;
  if (containsSchemaKeyword(schema, DRAFT_2019_KEYWORDS)) return DRAFT_2019_AJV;
  return DRAFT_07_AJV;
}

function containsSchemaKeyword(value: unknown, keywords: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSchemaKeyword(item, keywords));
  }
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (keywords.has(key)) return true;
    if (containsSchemaKeyword(child, keywords)) return true;
  }
  return false;
}

export type JsonType = null | number | string | boolean | JsonArray | JsonObject;

/** @internal */
export interface JsonArray extends Array<JsonType> {}

/** @internal */
export interface JsonObject extends Record<string, JsonType> {}

export type ToolArgsValidator = ValidateFunction<JsonType>;

function formatValidationError(error: ErrorObject, schema?: Record<string, unknown>): string {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `must have required property '${String(error.params['missingProperty'])}'`;
  }

  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    const prop = String(error.params['additionalProperty']);
    const hint = findSimilarProperty(prop, schema);
    const base = hint
      ? `unknown property '${prop}'. Did you mean '${hint}'?`
      : `must NOT have additional property '${prop}'`;
    const schemaHint = summarizeSchemaWithExamples(schema);
    return schemaHint ? `${base}\n${schemaHint}` : base;
  }

  const path = error.instancePath ? `${error.instancePath} ` : '';
  return `${path}${error.message ?? 'is invalid'}`;
}

export function compileToolArgsValidator(schema: Record<string, unknown>): ToolArgsValidator {
  return ajvFor(schema).compile(schema) as ToolArgsValidator;
}

export function validateToolArgs(
  validator: ToolArgsValidator,
  args: JsonType,
  schema?: Record<string, unknown>,
): string | null {
  const valid = validator(args);
  if (valid) {
    return null;
  }

  const errors = validator.errors ?? [];
  if (errors.length === 0) {
    return 'Tool parameter validation failed';
  }

  return errors.map((error) => formatValidationError(error, schema)).join('; ');
}

/**
 * Format a ZodError for LLM-friendly output.
 * Uses z.prettifyError() + schema summary + usage examples.
 */
export function formatZodError(
  error: z.ZodError,
  schema?: Record<string, unknown>,
): string {
  const prettified = z.prettifyError(error);
  const schemaHint = summarizeSchemaWithExamples(schema);
  return schemaHint ? `${prettified}\n${schemaHint}` : prettified;
}

/** Summarize tool parameter schema with examples for LLM consumption. */
function summarizeSchemaWithExamples(
  schema?: Record<string, unknown>,
): string | undefined {
  const props = schema?.['properties'] as Record<string, unknown> | undefined;
  if (!props) return undefined;
  const entries = Object.entries(props).map(([name, def]) => {
    const d = def as Record<string, unknown>;
    const type = d['type'] ?? 'unknown';
    const desc = d['description'] ?? '';
    const example = d['examples'] ?? d['default'];
    let line = `  - ${name}: ${type}`;
    if (desc) line += ` — ${String(desc).slice(0, 80)}`;
    if (example !== undefined) line += ` (e.g. ${JSON.stringify(example)})`;
    return line;
  });
  return `Supported parameters:\n${entries.join('\n')}`;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) (dp[i] as number[])[0] = i;
  for (let j = 0; j <= n; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      (dp[i] as number[])[j] = Math.min(
        (dp[i - 1] as number[])[j]! + 1,
        (dp[i] as number[])[j - 1]! + 1,
        (dp[i - 1] as number[])[j - 1]! + ((a[i - 1] === b[j - 1]) ? 0 : 1),
      );
    }
  }
  return (dp[m] as number[])[n]!;
}

function findSimilarProperty(
  name: string,
  schema?: Record<string, unknown>,
): string | undefined {
  const props = schema?.['properties'] as Record<string, unknown> | undefined;
  if (!props) return undefined;
  const candidates = Object.keys(props);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

// ─── Strategy Pattern: validateArgs factory ─────────────────────────────────

/**
 * AJV path normaliser. Converts JSON Pointer (`"/nested/field"`) to Dot
 * Notation (`"nested.field"`) so all validation errors share one format,
 * matching Zod's `issue.path.join('.')`.
 */
function normaliseAjvPath(instancePath: string): string {
  return instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)';
}

/**
 * Build a `validateArgs` function backed by AJV with strict mode.
 *
 * Use this for builtin tools whose Zod schema is the SSOT (via
 * `ZodToolBase`) and for legacy / MCP tools that only have JSON Schema.
 *
 * @param parameters - The tool's JSON Schema `parameters` object.
 * @param options.strict - AJV strict mode. `'log'` emits warnings instead
 *   of throwing on unknown keywords, which is safer for MCP tools whose
 *   schemas may use vendor extensions. Defaults to `'log'`.
 */
export function createAjvValidateArgs(
  parameters: Record<string, unknown>,
  options?: { readonly strict?: boolean | 'log' },
): (args: unknown) =>
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly errors: readonly ValidationError[] } {
  const strictMode = options?.strict ?? 'log';
  const ajv = new Ajv({
    strict: strictMode,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  const validate = ajv.compile(parameters);

  return (args: unknown) => {
    const valid = validate(args);
    if (valid) {
      return { success: true, data: args };
    }
    const ajvErrors = validate.errors ?? [];
    const errors: ValidationError[] = ajvErrors.map((e) => ({
      path: normaliseAjvPath(e.instancePath),
      message: formatValidationError(e, parameters),
      keyword: e.keyword,
    }));
    return { success: false, errors };
  };
}
