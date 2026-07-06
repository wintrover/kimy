/**
 * Sketch Parser / Assembler Test (Z3-Guided)
 *
 * Tests for `parseSketch`, `extractHoles`, `assembleSketchUnsafe`,
 * and `buildMutationsFromSketch` using Z3-guided deterministic fixture
 * generation for all test inputs.
 */

import { describe, expect, it } from 'vitest';

import { parseSketch, extractHoles } from '#/tools/synthesis/sketch-parser';
import {
  assembleSketchUnsafe,
  buildMutationsFromSketch,
  SketchAssemblyError,
  type Sketch as AssemblerSketch,
  type SynthesisResult,
  type HoleInfo,
} from '#/tools/synthesis/sketch-assembler';
import type { Sketch as ParserSketch } from '#/tools/synthesis/sketch-parser';
import {
  generateFixtures,
  type FixtureConstraint,
} from '../../helpers/z3-fixture-generator';

// ---------------------------------------------------------------------------
// Z3 fixture helpers — generate structural parameters deterministically
// ---------------------------------------------------------------------------

/** Stable counter to avoid Z3 variable name collisions across tests. */
let z3Counter = 0;

/**
 * Generate a deterministic small positive integer via Z3.
 *
 * Each constraint body is prefixed with `(declare-const name Int)` so that
 * `ast_from_string` can resolve the variable reference — Z3 tolerates
 * duplicate declarations when the types agree.
 */
async function z3Int(min: number, max: number): Promise<number> {
  const name = `param${String(z3Counter++)}`;
  const decl = `(declare-const ${name} Int)`;
  const constraints: FixtureConstraint[] = [
    {
      name,
      domain: 'int',
      constraints: [
        `${decl}(assert (>= ${name} ${String(min)}))`,
        `${decl}(assert (<= ${name} ${String(max)}))`,
      ],
    },
  ];
  const values = await generateFixtures(constraints);
  return Number(values.get(name));
}

/**
 * Generate a deterministic non-empty string via Z3.
 *
 * Constraint body includes `(declare-const name String)` for the
 * SMT-LIB2 parser.
 */
async function z3NonEmptyString(): Promise<string> {
  const name = `str${String(z3Counter++)}`;
  const decl = `(declare-const ${name} String)`;
  const constraints: FixtureConstraint[] = [
    {
      name,
      domain: 'string',
      constraints: [`${decl}(assert (> (str.len ${name}) 0))`],
    },
  ];
  const values = await generateFixtures(constraints);
  return values.get(name) ?? '';
}

// ---------------------------------------------------------------------------
// Bridge: parser Sketch → assembler Sketch
// ---------------------------------------------------------------------------

/**
 * Convert a parser-style Sketch into an assembler-style Sketch so that
 * roundtrip tests can exercise both modules end-to-end.
 */
function toAssemblerSketch(
  parserSketch: ParserSketch,
  filePath: string,
): AssemblerSketch {
  const holes: HoleInfo[] = parserSketch.holes.map((hole) => ({
    id: hole.id,
    placeholder: '??',
    node_id: `${filePath}::node#${hole.domain}`,
  }));
  return {
    template: parserSketch.template,
    holes,
    originalSource: parserSketch.template,
    filePath,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Z3-Guided Sketch Parsing', () => {
  it('type hole fixture: detects a type-domain hole', async () => {
    // Use Z3 to generate a deterministic identifier name for the source.
    const identSrc = await z3NonEmptyString();
    const safeName = identSrc.replace(/[^a-zA-Z_]/g, '_').slice(0, 8) || 'val';
    // Source: `const <name>: ?? = 1;` — the `??` is in type-annotation position.
    const src = `const ${safeName}: ?? = 1;`;

    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.holes).toHaveLength(1);
    expect(sketch.holes[0]!.domain).toBe('type');
    expect(sketch.template).toBe(src);
  });

  it('expression hole fixture: detects an expression-domain hole', async () => {
    const identSrc = await z3NonEmptyString();
    const safeName = identSrc.replace(/[^a-zA-Z_]/g, '_').slice(0, 8) || 'x';
    const src = `const ${safeName} = ??;`;

    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.holes).toHaveLength(1);
    expect(sketch.holes[0]!.domain).toBe('expression');
  });

  it('multiple holes fixture: extractHoles returns correct count', async () => {
    const holeCount = await z3Int(2, 5);

    // Build source with exactly `holeCount` holes.
    const parts: string[] = ['function f() {'];
    for (let i = 0; i < holeCount; i++) {
      parts.push(`  const _v${String(i)} = ??;`);
    }
    parts.push('}');
    const src = parts.join('\n');

    const sketch = parseSketch(src, 'test.ts');
    const holes = extractHoles(sketch);
    expect(holes).toHaveLength(holeCount);
    // All holes in this layout are in expression position.
    for (const hole of holes) {
      expect(hole.domain).toBe('expression');
    }
  });

  it('specification annotations: preconditions extracted', async () => {
    const preBody = await z3NonEmptyString();
    // Sanitise to safe SMT-like predicate text for use in a comment.
    const safeBody = preBody.replace(/[^a-zA-Z0-9_.><= ]/g, '').slice(0, 20) || 'x > 0';
    const src = `// @precondition: ${safeBody}\nfunction g(): ?? { return ??; }`;

    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.specification.preconditions).toContain(safeBody);
    // Two holes: one type (return type), one expression (return value).
    expect(sketch.holes.length).toBeGreaterThanOrEqual(2);
  });

  it('specification annotations: postconditions and invariants', () => {
    const src = [
      '// @postcondition: result != null',
      '// @invariant: list.length > 0',
      '// @type_constraint: number',
      'function h(x: ??): ?? { return ??; }',
    ].join('\n');

    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.specification.postconditions).toContain('result != null');
    expect(sketch.specification.invariants).toContain('list.length > 0');
    expect(sketch.specification.typeConstraints).toContain('number');
  });
});

describe('Z3-Guided Sketch Assembly', () => {
  it('single hole fill: assembleSketchUnsafe replaces hole', async () => {
    const fillRaw = await z3NonEmptyString();
    const safeFill = fillRaw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 12) || 'hello';
    const src = 'const x = ??;';

    const parserSketch = parseSketch(src, 'test.ts');
    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');

    const synthesisResult: SynthesisResult = {
      holeValues: new Map([[assemblerSketch.holes[0]!.id, safeFill]]),
    };

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);
    expect(result.completeSource).toBe(`const x = ${safeFill};`);
    expect(result.sourceMap.get(assemblerSketch.holes[0]!.id)).toBe(safeFill);
  });

  it('multiple holes fill: all holes replaced correctly', async () => {
    const fill1Raw = await z3NonEmptyString();
    const fill2Raw = await z3NonEmptyString();
    const safeFill1 = fill1Raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 12) || 'foo';
    const safeFill2 = fill2Raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 12) || 'bar';

    const src = 'function f() { const a = ??; const b = ??; }';
    const parserSketch = parseSketch(src, 'test.ts');
    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');

    expect(assemblerSketch.holes).toHaveLength(2);

    const synthesisResult: SynthesisResult = {
      holeValues: new Map([
        [assemblerSketch.holes[0]!.id, safeFill1],
        [assemblerSketch.holes[1]!.id, safeFill2],
      ]),
    };

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);
    expect(result.completeSource).toBe(
      `function f() { const a = ${safeFill1}; const b = ${safeFill2}; }`,
    );
    expect(result.sourceMap.size).toBe(2);
  });

  it('reverse-offset ordering: assembler handles offset preservation', () => {
    // Create holes at very different positions to exercise reverse-order replacement.
    const fillA = 'alpha';
    const fillB = 'beta';
    const src = 'const _a = ??; function _nested() { const _b = ??; }';

    const parserSketch = parseSketch(src, 'test.ts');
    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');

    expect(assemblerSketch.holes).toHaveLength(2);

    const synthesisResult: SynthesisResult = {
      holeValues: new Map([
        [assemblerSketch.holes[0]!.id, fillA],
        [assemblerSketch.holes[1]!.id, fillB],
      ]),
    };

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);
    expect(result.completeSource).toBe(
      `const _a = ${fillA}; function _nested() { const _b = ${fillB}; }`,
    );
  });
});

describe('Z3-Guided Roundtrip', () => {
  it('parse → fill → verify: assembled source has no remaining ??', async () => {
    const count = await z3Int(1, 4);

    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      parts.push(`_${String(i)} = ??`);
    }
    const src = `const ${parts.join(', ')};`;

    const parserSketch = parseSketch(src, 'test.ts');
    expect(parserSketch.holes).toHaveLength(count);

    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');
    const holeValues = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      holeValues.set(assemblerSketch.holes[i]!.id, `val${String(i)}`);
    }

    const synthesisResult: SynthesisResult = { holeValues };
    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);

    // No remaining `??` in the assembled source.
    expect(result.completeSource).not.toContain('??');
    // Each value is present in the output.
    for (let i = 0; i < count; i++) {
      expect(result.completeSource).toContain(`val${String(i)}`);
    }
  });

  it('consistency: extractHoles count matches assembler hole count', async () => {
    const count = await z3Int(2, 6);

    const parts: string[] = ['{'];
    for (let i = 0; i < count; i++) {
      parts.push(`  const _x${String(i)} = ??;`);
    }
    parts.push('}');
    const src = parts.join('\n');

    const parserSketch = parseSketch(src, 'test.ts');
    const extractedHoles = extractHoles(parserSketch);
    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');

    expect(extractedHoles.length).toBe(assemblerSketch.holes.length);
    expect(extractedHoles.length).toBe(count);
  });
});

describe('Edge Cases (deterministic)', () => {
  it('empty source: parseSketch returns valid sketch with no holes', () => {
    const sketch = parseSketch('', 'test.ts');
    expect(sketch.holes).toHaveLength(0);
    expect(sketch.specification.preconditions).toHaveLength(0);
    expect(sketch.specification.postconditions).toHaveLength(0);
    expect(sketch.specification.invariants).toHaveLength(0);
    expect(sketch.specification.typeConstraints).toHaveLength(0);
  });

  it('no holes: const x = 1; yields empty hole list', () => {
    const sketch = parseSketch('const x = 1;', 'test.ts');
    expect(sketch.holes).toHaveLength(0);
  });

  it('triple question mark: `???` after identifier matches one hole', () => {
    // The regex /(?<!\?)\?\?(?!=)/g matches `??` that is NOT preceded by `?`
    // and NOT followed by `=`.
    // In `a ??? b`, the first `??` at offset 2 is preceded by ` ` (space),
    // so it matches. The second `??` at offset 3 is preceded by `?`, so it
    // does NOT match.
    const src = 'a ??? b';
    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.holes).toHaveLength(1);
  });

  it('triple question mark at start: `???` matches one hole', () => {
    // `???x` — first `??` at offset 0, preceded by nothing (not `?`), matches.
    // Second `??` at offset 1, preceded by `?`, does not match.
    const src = '???x';
    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.holes).toHaveLength(1);
  });

  it('nullish coalescing assignment: ??= is NOT detected as a hole', () => {
    const src = 'a ??= b';
    const sketch = parseSketch(src, 'test.ts');
    // `??=` should NOT match because the lookahead `(?!=)` blocks it.
    expect(sketch.holes).toHaveLength(0);
  });

  it('single question mark: ? is NOT detected as a hole', () => {
    const src = 'const x = a ? b : c;';
    const sketch = parseSketch(src, 'test.ts');
    expect(sketch.holes).toHaveLength(0);
  });

  it('assembleSketchUnsafe throws on missing synthesis values', () => {
    const src = 'const x = ??;';
    const parserSketch = parseSketch(src, 'test.ts');
    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');

    // Empty holeValues — should throw.
    const synthesisResult: SynthesisResult = { holeValues: new Map() };
    expect(() => assembleSketchUnsafe(assemblerSketch, synthesisResult)).toThrow(
      SketchAssemblyError,
    );
  });

  it('assembleSketchUnsafe throws when sketch has no holes', () => {
    const assemblerSketch: AssemblerSketch = {
      template: 'const x = 1;',
      holes: [],
      originalSource: 'const x = 1;',
      filePath: 'test.ts',
    };
    const synthesisResult: SynthesisResult = { holeValues: new Map() };
    expect(() => assembleSketchUnsafe(assemblerSketch, synthesisResult)).toThrow(
      SketchAssemblyError,
    );
  });

  it('buildMutationsFromSketch: generates mutations for each hole', async () => {
    const fillA = 'alpha';
    const fillB = 'beta';
    const src = 'const x = ??; const y = ??;';

    const parserSketch = parseSketch(src, 'test.ts');
    const assemblerSketch = toAssemblerSketch(parserSketch, 'test.ts');

    const synthesisResult: SynthesisResult = {
      holeValues: new Map([
        [assemblerSketch.holes[0]!.id, fillA],
        [assemblerSketch.holes[1]!.id, fillB],
      ]),
    };

    const mutations = buildMutationsFromSketch(assemblerSketch, synthesisResult);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]!.replacement).toBe(fillA);
    expect(mutations[0]!.operation).toBe('replace');
    expect(mutations[1]!.replacement).toBe(fillB);
    expect(mutations[1]!.operation).toBe('replace');
  });
});
