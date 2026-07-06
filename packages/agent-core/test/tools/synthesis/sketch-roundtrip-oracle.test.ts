/**
 * Sketch Roundtrip Oracle Test
 *
 * Verifies sketch-parser ↔ sketch-assembler roundtrip using the Lean 4
 * oracle for differential testing.
 *
 * The oracle binary (tools/lean4-verification/lean4-oracle/.lake/build/bin/oracle)
 * reads JSON from stdin and outputs JSON to stdout. When the binary is not
 * compiled, oracle-dependent tests are skipped.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';

import {
  parseSketch,
  extractHoles,
  type Sketch as ParserSketch,
} from '#/tools/synthesis/sketch-parser';
import {
  assembleSketchUnsafe,
  SketchAssemblyError,
  type Sketch as AssemblerSketch,
  type SynthesisResult,
  type HoleInfo,
} from '#/tools/synthesis/sketch-assembler';

// ---------------------------------------------------------------------------
// Oracle helper (skipped if not available)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const ORACLE_PATH = './tools/lean4-verification/lean4-oracle/.lake/build/bin/oracle';

let oracleAvailable = false;
try {
  await access(ORACLE_PATH);
  oracleAvailable = true;
} catch {
  // Binary not compiled — oracle tests will be skipped.
}

interface OracleResponse {
  ok: boolean;
  result?: { holes: number[]; count: number; source: string };
  reason?: string;
}

async function leanOracle(input: unknown): Promise<OracleResponse> {
  const { stdout } = await execFileAsync(ORACLE_PATH, [], {
    input: JSON.stringify(input),
    timeout: 5_000,
  });
  return JSON.parse(stdout) as OracleResponse;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bridge a parser Sketch's holes to the assembler's HoleInfo format.
 */
function toAssemblerSketch(
  parserSketch: ParserSketch,
  filePath: string,
): AssemblerSketch {
  const holes: HoleInfo[] = parserSketch.holes.map((h) => ({
    id: h.id,
    placeholder: '??',
    node_id: h.id,
    expectedType: h.domain === 'type' ? 'type' : undefined,
    context: h.constraints.length > 0 ? h.constraints.join('; ') : undefined,
  }));
  return {
    template: parserSketch.template,
    holes,
    originalSource: parserSketch.template,
    filePath,
  };
}

/**
 * Create a SynthesisResult mapping each hole id to a concrete fill value.
 */
function fillWith(
  parserSketch: ParserSketch,
  values: string[],
): SynthesisResult {
  if (parserSketch.holes.length !== values.length) {
    throw new Error(
      `Expected ${parserSketch.holes.length} fill values, got ${values.length}`,
    );
  }
  const holeValues = new Map<string, string>();
  for (let i = 0; i < parserSketch.holes.length; i++) {
    holeValues.set(parserSketch.holes[i]!.id, values[i]!);
  }
  return { holeValues };
}

/**
 * Detect `??` positions in source (replicates the parser's HOLE_REGEX logic).
 */
function detectHolePositions(source: string): number[] {
  const regex = /(?<!\?)\?\?(?!=)/g;
  const positions: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    positions.push(match.index);
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sketch roundtrip — oracle differential testing', () => {
  describe.skipIf(!oracleAvailable)(
    'oracle differential',
    () => {
      const filePath = 'test.ts';

      it('hole-less source: parser and oracle agree on zero holes', async () => {
        const source = 'const x = 5;';
        const sketch = parseSketch(source, filePath);

        expect(sketch.holes).toHaveLength(0);
        expect(sketch.template).toBe(source);

        const oracleResult = await leanOracle({
          command: 'sketch_roundtrip',
          source,
        });
        expect(oracleResult.ok).toBe(true);
        expect(oracleResult.result!.count).toBe(0);
        expect(oracleResult.result!.holes).toHaveLength(0);
      });

      it('single type hole: parser and oracle find the same hole', async () => {
        const source = 'const x: ?? = 5;';
        const sketch = parseSketch(source, filePath);

        expect(sketch.holes).toHaveLength(1);
        expect(sketch.holes[0]!.domain).toBe('type');

        const oracleResult = await leanOracle({
          command: 'sketch_roundtrip',
          source,
        });
        expect(oracleResult.ok).toBe(true);
        expect(oracleResult.result!.count).toBe(1);
        expect(oracleResult.result!.holes).toHaveLength(1);
        expect(oracleResult.result!.holes[0]).toBe(
          detectHolePositions(source)[0],
        );
      });

      it('single expression hole: parser and oracle agree', async () => {
        const source = 'const x = ??;';
        const sketch = parseSketch(source, filePath);

        expect(sketch.holes).toHaveLength(1);
        expect(sketch.holes[0]!.domain).toBe('expression');

        const oracleResult = await leanOracle({
          command: 'sketch_roundtrip',
          source,
        });
        expect(oracleResult.ok).toBe(true);
        expect(oracleResult.result!.count).toBe(1);
        expect(oracleResult.result!.holes[0]).toBe(
          detectHolePositions(source)[0],
        );
      });

      it('multiple holes: parser and oracle agree on count and positions', async () => {
        const source = 'function add(a: ??, b: ??): ?? { return a + b; }';
        const sketch = parseSketch(source, filePath);
        const tsPositions = detectHolePositions(source);

        expect(sketch.holes).toHaveLength(tsPositions.length);
        expect(sketch.holes.length).toBeGreaterThanOrEqual(2);

        const oracleResult = await leanOracle({
          command: 'sketch_roundtrip',
          source,
        });
        expect(oracleResult.ok).toBe(true);
        expect(oracleResult.result!.count).toBe(tsPositions.length);
        expect(oracleResult.result!.holes).toEqual(tsPositions);
      });

      it('oracle differential: TS hole count matches oracle for each source', async () => {
        const sources = [
          'const x = 5;',
          'const x: ?? = 5;',
          'const x = ??;',
          'function f(a: ??): ?? { return ??; }',
          'let a = ??, b = ??;',
        ];

        for (const source of sources) {
          const sketch = parseSketch(source, filePath);
          const oracleResult = await leanOracle({
            command: 'sketch_roundtrip',
            source,
          });
          expect(oracleResult.ok).toBe(true);
          expect(oracleResult.result!.count).toBe(sketch.holes.length);
        }
      });
    },
  );
});

describe('sketch roundtrip — pure TypeScript (no oracle)', () => {
  it('empty source: parseSketch returns valid sketch with no holes', () => {
    const sketch = parseSketch('', 'test.ts');
    expect(sketch.holes).toHaveLength(0);
    expect(sketch.template).toBe('');
    expect(sketch.id).toBeDefined();
    expect(sketch.targetNode).toBe('test.ts::program[0]');
    expect(sketch.specification).toEqual({
      preconditions: [],
      postconditions: [],
      invariants: [],
      typeConstraints: [],
    });
  });

  it('source with ?? in strings: parser still detects template holes', () => {
    const source = 'const label = "hello ?? world";\nconst x = ??;';
    const sketch = parseSketch(source, 'test.ts');

    // HOLE_REGEX matches all ?? occurrences regardless of string context.
    expect(sketch.holes).toHaveLength(2);
  });

  it('source with ??? (triple ?): parser detects exactly one hole, not two', () => {
    const source = 'const x = ???;';
    const sketch = parseSketch(source, 'test.ts');

    // The HOLE_REGEX /(?<!\?)\?\?(?!=)/g matches the first ?? pair
    // at position 10, but the second overlapping pair at position 11
    // is rejected because it is preceded by '?'.  Result: 1 hole.
    expect(sketch.holes).toHaveLength(1);

    // Verify the hole position is the start of the triple-?.
    const positions = detectHolePositions(source);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toBe(source.indexOf('???'));
  });

  it('source with ??= (nullish coalescing assignment): no holes detected', () => {
    const source = 'let x ??= 5;';
    const sketch = parseSketch(source, 'test.ts');

    // The HOLE_REGEX excludes ??= via the negative lookahead (?!=).
    expect(sketch.holes).toHaveLength(0);
  });

  it('extractHoles consistency: returns same holes as parseSketch', () => {
    const source = 'const a: ?? = ??; const b = ??;';
    const sketch = parseSketch(source, 'test.ts');

    const extracted = extractHoles(sketch);

    expect(extracted).toHaveLength(sketch.holes.length);

    for (let i = 0; i < sketch.holes.length; i++) {
      expect(extracted[i]!.id).toBe(sketch.holes[i]!.id);
      expect(extracted[i]!.domain).toBe(sketch.holes[i]!.domain);
      expect(extracted[i]!.constraints).toEqual(sketch.holes[i]!.constraints);
    }
  });

  it('assembler with filled values: replaces ?? correctly', () => {
    const source = 'const x: ?? = ??;';
    const sketch = parseSketch(source, 'test.ts');

    expect(sketch.holes).toHaveLength(2);

    const assemblerSketch = toAssemblerSketch(sketch, 'test.ts');
    const synthesisResult = fillWith(sketch, ['number', '42']);

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);

    expect(result.completeSource).toBe('const x: number = 42;');
    expect(result.sourceMap.size).toBe(2);
  });

  it('hole-less source roundtrip: template equals original', () => {
    const source = 'const x = 5;';
    const sketch = parseSketch(source, 'test.ts');

    // No holes — the roundtrip is trivially the identity.
    expect(sketch.holes).toHaveLength(0);
    expect(sketch.template).toBe(source);
  });

  it('single type hole roundtrip: fill restores original', () => {
    const template = 'const x: ?? = 5;';
    const expected = 'const x: number = 5;';

    const sketch = parseSketch(template, 'test.ts');
    expect(sketch.holes).toHaveLength(1);
    expect(sketch.holes[0]!.domain).toBe('type');

    const assemblerSketch = toAssemblerSketch(sketch, 'test.ts');
    const synthesisResult = fillWith(sketch, ['number']);

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);
    expect(result.completeSource).toBe(expected);
  });

  it('single expression hole roundtrip: fill restores original', () => {
    const template = 'const x = ??;';
    const expected = 'const x = 42;';

    const sketch = parseSketch(template, 'test.ts');
    expect(sketch.holes).toHaveLength(1);
    expect(sketch.holes[0]!.domain).toBe('expression');

    const assemblerSketch = toAssemblerSketch(sketch, 'test.ts');
    const synthesisResult = fillWith(sketch, ['42']);

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);
    expect(result.completeSource).toBe(expected);
  });

  it('multiple holes roundtrip: all holes filled correctly', () => {
    const template = 'function add(a: ??, b: ??): ?? { return a + b; }';
    const expected = 'function add(a: number, b: number): number { return a + b; }';

    const sketch = parseSketch(template, 'test.ts');
    expect(sketch.holes).toHaveLength(3);

    const assemblerSketch = toAssemblerSketch(sketch, 'test.ts');
    const synthesisResult = fillWith(sketch, ['number', 'number', 'number']);

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);
    expect(result.completeSource).toBe(expected);
    expect(result.sourceMap.size).toBe(3);
  });

  it('assembler throws when holes are missing values', () => {
    const source = 'const x = ??;';
    const sketch = parseSketch(source, 'test.ts');
    const assemblerSketch = toAssemblerSketch(sketch, 'test.ts');

    // Empty synthesis result — no values provided.
    const synthesisResult: SynthesisResult = { holeValues: new Map() };

    expect(() =>
      assembleSketchUnsafe(assemblerSketch, synthesisResult),
    ).toThrow(SketchAssemblyError);
  });

  it('assembler throws when sketch has no holes', () => {
    const assemblerSketch: AssemblerSketch = {
      template: 'const x = 5;',
      holes: [],
      originalSource: 'const x = 5;',
      filePath: 'test.ts',
    };
    const synthesisResult: SynthesisResult = { holeValues: new Map() };

    expect(() =>
      assembleSketchUnsafe(assemblerSketch, synthesisResult),
    ).toThrow(SketchAssemblyError);
  });

  it('hole domain classification: type vs expression vs parameter', () => {
    const source = 'function f(x: ??): ?? { const y: ?? = ??; }';
    const sketch = parseSketch(source, 'test.ts');

    // The string-context classifier should identify domains:
    // - `x: ??` in function params → parameter (or type depending on context)
    // - `): ??` return type → type
    // - `y: ??` variable annotation → type
    // - `= ??` expression → expression
    expect(sketch.holes.length).toBeGreaterThanOrEqual(3);

    // At least one should be classified as 'type' (the `: ??` patterns).
    const typeHoles = sketch.holes.filter((h) => h.domain === 'type');
    expect(typeHoles.length).toBeGreaterThanOrEqual(1);

    // At least one should be classified as 'expression' (the `= ??` pattern).
    const exprHoles = sketch.holes.filter((h) => h.domain === 'expression');
    expect(exprHoles.length).toBeGreaterThanOrEqual(1);
  });

  it('specification annotations extracted from sketch', () => {
    const source = [
      '// @precondition: x > 0',
      '// @postcondition: result != null',
      '// @invariant: list.length > 0',
      '// @type_constraint: number',
      'const f = (x: ??) => ??;',
    ].join('\n');

    const sketch = parseSketch(source, 'test.ts');
    expect(sketch.specification.preconditions).toEqual(['x > 0']);
    expect(sketch.specification.postconditions).toEqual(['result != null']);
    expect(sketch.specification.invariants).toEqual(['list.length > 0']);
    expect(sketch.specification.typeConstraints).toEqual(['number']);
  });

  it('roundtrip preserves non-hole content exactly', () => {
    const template = '// header comment\nconst a: ?? = 1;\nconst b = ?? + 2;\n// footer';
    const sketch = parseSketch(template, 'test.ts');

    expect(sketch.holes).toHaveLength(2);

    const assemblerSketch = toAssemblerSketch(sketch, 'test.ts');
    const synthesisResult = fillWith(sketch, ['number', 'x']);

    const result = assembleSketchUnsafe(assemblerSketch, synthesisResult);

    // All non-hole content (comments, whitespace, other tokens) preserved.
    expect(result.completeSource).toBe(
      '// header comment\nconst a: number = 1;\nconst b = x + 2;\n// footer',
    );
  });
});
