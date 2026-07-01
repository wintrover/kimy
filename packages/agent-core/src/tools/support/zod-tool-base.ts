/**
 * Abstract base class for tools whose Zod schema is the single source of truth.
 *
 * Subclasses declare a static `schema` and inherit `parameters` (JSON Schema,
 * auto-derived) and `validateArgs` (Zod safeParse with coercion) for free.
 * The schema is compiled to JSON Schema exactly once via `toInputJsonSchema`.
 *
 * `validateArgs` uses Zod's `safeParse` directly — no AJV involvement — so
 * coercion (`z.coerce.number`, etc.) and custom refinements work exactly as
 * declared. On failure, Zod issues are mapped to {@link ValidationError}[]
 * with Dot Notation paths, matching the AJV path format produced by
 * `createAjvValidateArgs`.
 */

import type { z } from 'zod';

import type { ExecutableTool, ValidationError } from '../../loop/types';
import { toInputJsonSchema } from './input-schema';

/**
 * Map a ZodError to the unified `ValidationError[]` shape.
 *
 * Zod paths are already arrays of (string | number); joining them with `.`
 * produces the same Dot Notation that the AJV normaliser emits.
 */
function zodIssuesToValidationErrors(error: z.ZodError): readonly ValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
    keyword: issue.code,
  }));
}

/**
 * Abstract base for tools that use a Zod schema as their single source of truth.
 *
 * Subclasses must set `readonly schema` to a Zod object schema. The base class
 * provides:
 * - `parameters`: JSON Schema auto-derived from `schema` (via `z.toJSONSchema`).
 * - `validateArgs`: Zod `safeParse` with coercion, returning structured
 *   `ValidationError[]` on failure.
 *
 * @typeParam S - The Zod schema type (must be a `z.ZodType`).
 */
export abstract class ZodToolBase<S extends z.ZodType> implements ExecutableTool<z.Infer<S>> {
  abstract readonly name: string;
  abstract readonly description: string;

  /** The Zod schema that is the SSOT for this tool's parameters. */
  abstract readonly schema: S;

  /**
   * JSON Schema derived from `schema` once at construction time.
   * Computed lazily on first access to avoid issues with abstract field
   * initialisation order.
   */
  private _parameters: Record<string, unknown> | undefined;

  get parameters(): Record<string, unknown> {
    if (this._parameters === undefined) {
      this._parameters = toInputJsonSchema(this.schema);
    }
    return this._parameters;
  }

  validateArgs(
    args: unknown,
  ):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly errors: readonly ValidationError[] } {
    const result = this.schema.safeParse(args);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, errors: zodIssuesToValidationErrors(result.error) };
  }

  abstract resolveExecution(
    input: z.Infer<S>,
  ): import('../../loop/types').ToolExecution | Promise<import('../../loop/types').ToolExecution>;
}
