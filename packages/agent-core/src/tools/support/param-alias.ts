import { z } from 'zod';

type Aliases = Record<string, string[]>;

/**
 * Build an "input" shape where every canonical key becomes optional and alias
 * keys are injected as optional strings.  The input object is what the LLM
 * (and AJV) sees — it accepts both the canonical name and any alias.
 */
function buildInputShape(shape: z.ZodRawShape, aliases: Aliases): z.ZodRawShape {
  const extended: z.ZodRawShape = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    extended[key] = (fieldSchema as z.ZodTypeAny).optional();
  }
  for (const aliasNames of Object.values(aliases)) {
    for (const alias of aliasNames) {
      if (!(alias in extended)) {
        extended[alias] = z
          .string()
          .optional()
          .describe('Alias — normalized to the canonical parameter at runtime.');
      }
    }
  }
  return extended;
}

/**
 * Create a pure normalizer function (no Zod overhead).
 *
 * For every canonical ↔ alias mapping:
 *   1. If the canonical key is nullish, copy the first non-null alias value.
 *   2. Delete every alias key from the result.
 */
function createNormalizer(aliases: Aliases) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const cleaned = { ...args };
    for (const [canonical, aliasNames] of Object.entries(aliases)) {
      if (cleaned[canonical] == null) {
        for (const alias of aliasNames) {
          if (cleaned[alias] != null) {
            cleaned[canonical] = cleaned[alias];
            break;
          }
        }
      }
      for (const alias of aliasNames) {
        delete cleaned[alias];
      }
    }
    return cleaned;
  };
}

/**
 * Alias-aware object schema factory.
 *
 * Returns a ZodPipe whose **input** side exposes both canonical and alias keys
 * (so `z.toJSONSchema(schema, { io: 'input' })` advertises them to the LLM),
 * whose **transform** normalizes aliases to canonical form, and whose **output**
 * side validates the original shape (canonical keys required).
 *
 * An extra `normalizeInput` helper is attached for call-sites that already
 * trust their input (e.g. after AJV validation) and only need the rename.
 */
export function aliasedObject<T extends z.ZodRawShape>(
  shape: T,
  aliases: Aliases,
) {
  const inputShape = buildInputShape(shape, aliases);
  const normalizer = createNormalizer(aliases);

  const schema = z.pipe(
    z.pipe(z.object(inputShape), z.transform(normalizer)),
    z.object(shape),
  );

  return Object.assign(schema, { normalizeInput: normalizer });
}
