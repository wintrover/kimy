import { describe, it, expect } from 'vitest';

import { translateNifToConstraints, translateContractToZ3 } from '#/tools/hooks/constraint-translator';
import type { NifContractOutput, NifSymbol, ConstraintSet } from '#/tools/hooks/constraint-translator';
import type { AgentContract } from '#/tools/hooks/contract-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNifSymbol(overrides: Partial<NifSymbol> = {}): NifSymbol {
  return {
    symbol: 'testFunc',
    ...overrides,
  };
}

function makeNifOutput(overrides: Partial<NifContractOutput> = {}): NifContractOutput {
  return {
    format: 'kimi-agent-swarm-nif-contract',
    version: '1.0',
    symbols: [],
    ...overrides,
  };
}

function makeContract(overrides: Partial<AgentContract> = {}): AgentContract {
  return {
    id: 'test-contract',
    allowedEffects: [],
    prohibitedEffects: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('translateNifToConstraints', () => {
  describe('NIF JSON object input', () => {
    it('returns ConstraintSet with correct structure from NIF JSON', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'foo', effectPragma: ['gcsafe', 'noSideEffect'] }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.source).toBe('nif');
      expect(result.z3Assertions).toBeInstanceOf(Array);
      expect(result.effects).toBeInstanceOf(Map);
      expect(result.typeConstraints).toBeInstanceOf(Map);
    });

    it('populates effects Map correctly', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'foo', effectPragma: ['gcsafe', 'noSideEffect'] }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.effects.has('foo')).toBe(true);
      expect(result.effects.get('foo')).toEqual(['gcsafe', 'noSideEffect']);
    });

    it('populates typeConstraints Map from typeSignature', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'bar', typeSignature: 'bool' }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.typeConstraints.has('bar')).toBe(true);
      expect(result.typeConstraints.get('bar')).toBe('bool');
    });

    it('extracts return type from full signature string', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'baz', typeSignature: '(x: int): bool' }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.typeConstraints.get('baz')).toBe('bool');
      expect(result.z3Assertions).toContainEqual(
        '(assert (= (return_type "baz") "bool"))',
      );
    });

    it('skips return type when signature starts with ( but no ):', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'noRet', typeSignature: '(x: int)' }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.typeConstraints.has('noRet')).toBe(false);
    });

    it('adds macro_expanded assertion for JSON symbols', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'macroSym', macroExpanded: true }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.z3Assertions).toContainEqual(
        '(assert (macro_expanded "macroSym" true))',
      );
    });

    it('does not add macro_expanded when macroExpanded is false', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'normalSym', macroExpanded: false }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.z3Assertions).not.toContainEqual(
        '(assert (macro_expanded "normalSym" true))',
      );
    });

    it('translates multiple symbols', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'a', effectPragma: ['gcsafe'] }),
          makeNifSymbol({ symbol: 'b', effectPragma: ['WriteIOEffect'] }),
          makeNifSymbol({ symbol: 'c', typeSignature: 'int' }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.effects.size).toBe(2);
      expect(result.effects.get('a')).toEqual(['gcsafe']);
      expect(result.effects.get('b')).toEqual(['WriteIOEffect']);
      expect(result.typeConstraints.get('c')).toBe('int');
    });

    it('maps effect tags to semantic categories', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'f', effectPragma: ['gcsafe', 'noSideEffect', 'WriteIOEffect'] }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "f" "GCSafe"))',
      );
      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "f" "Pure"))',
      );
      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "f" "IOEffect"))',
      );
    });

    it('passes unknown effect tags through verbatim', () => {
      const nifData = makeNifOutput({
        symbols: [
          makeNifSymbol({ symbol: 'g', effectPragma: ['customEffect'] }),
        ],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "g" "customEffect"))',
      );
    });
  });

  describe('NIF S-expression string input', () => {
    it('parses S-expression string and returns ConstraintSet', () => {
      // S-expression format: symbol name is a bare first-child identifier.
      // The pragma path correctly extracts effect tags, skipping sub-tag names.
      const sexpr = '(myFunc (pragma (efx gcsafe) (efx noSideEffect)))';
      const result = translateNifToConstraints(sexpr);

      expect(result.source).toBe('nif');
      expect(result.effects.has('myFunc')).toBe(true);
      expect(result.effects.get('myFunc')).toEqual(['gcsafe', 'noSideEffect']);
      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "myFunc" "GCSafe"))',
      );
      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "myFunc" "Pure"))',
      );
    });

    it('extracts parameter types from S-expression params child', () => {
      const sexpr = '(myFunc (params (x int) (y string)))';
      const result = translateNifToConstraints(sexpr);

      expect(result.z3Assertions).toContainEqual(
        '(assert (= (param_type "myFunc" "x") "int"))',
      );
      expect(result.z3Assertions).toContainEqual(
        '(assert (= (param_type "myFunc" "y") "string"))',
      );
    });

    it('detects macro expansion via expandedFrom child', () => {
      const sexpr = '(macroFunc (expandedFrom (sym macros)))';
      const result = translateNifToConstraints(sexpr);

      expect(result.z3Assertions).toContainEqual(
        '(assert (macro_expanded "macroFunc" true))',
      );
    });

    it('detects macro expansion via macroExp child', () => {
      const sexpr = '(macroFunc (macroExp true))';
      const result = translateNifToConstraints(sexpr);

      expect(result.z3Assertions).toContainEqual(
        '(assert (macro_expanded "macroFunc" true))',
      );
    });

    it('parses multiple top-level S-expressions', () => {
      const sexpr = '(f1 (pragma (efx gcsafe))) (f2 (ret bool))';
      const result = translateNifToConstraints(sexpr);

      expect(result.effects.has('f1')).toBe(true);
      expect(result.effects.get('f1')).toEqual(['gcsafe']);
      // (ret bool) via getText returns 'ret' (first leaf of group)
      expect(result.typeConstraints.has('f2')).toBe(true);
    });

    it('handles effect pragmas nested in pragma node', () => {
      // The pragma path starts inner loops at i=1, correctly skipping the 'efx' tag name.
      const sexpr = '(myFunc (pragma (efx gcsafe) (efx tags WriteIOEffect)))';
      const result = translateNifToConstraints(sexpr);

      expect(result.effects.has('myFunc')).toBe(true);
      expect(result.effects.get('myFunc')).toEqual(['gcsafe', 'tags', 'WriteIOEffect']);
    });

    it('handles direct efx node (includes tag name)', () => {
      // The direct efx path iterates ALL children including the 'efx' ident.
      const sexpr = '(myFunc (efx gcsafe noSideEffect))';
      const result = translateNifToConstraints(sexpr);

      expect(result.effects.get('myFunc')).toEqual(['efx', 'gcsafe', 'noSideEffect']);
    });

    it('handles effects sub-node in S-expression', () => {
      // The effects path iterates ALL children including the 'effects' ident.
      const sexpr = '(myFunc (effects ReadIOEffect))';
      const result = translateNifToConstraints(sexpr);

      expect(result.effects.get('myFunc')).toEqual(['effects', 'ReadIOEffect']);
      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "myFunc" "effects"))',
      );
      expect(result.z3Assertions).toContainEqual(
        '(assert (has_tag "myFunc" "IOEffect"))',
      );
    });
  });

  describe('empty and edge cases', () => {
    it('returns empty ConstraintSet for empty NIF output', () => {
      const nifData = makeNifOutput({ symbols: [] });
      const result = translateNifToConstraints(nifData);

      expect(result.z3Assertions).toEqual([]);
      expect(result.effects.size).toBe(0);
      expect(result.typeConstraints.size).toBe(0);
      expect(result.source).toBe('nif');
    });

    it('returns empty ConstraintSet for empty string', () => {
      const result = translateNifToConstraints('');

      expect(result.z3Assertions).toEqual([]);
      expect(result.effects.size).toBe(0);
      expect(result.typeConstraints.size).toBe(0);
    });

    it('returns empty ConstraintSet for null', () => {
      const result = translateNifToConstraints(null);

      expect(result.z3Assertions).toEqual([]);
      expect(result.effects.size).toBe(0);
    });

    it('returns empty ConstraintSet for non-object non-string', () => {
      const result = translateNifToConstraints(42);

      expect(result.z3Assertions).toEqual([]);
      expect(result.effects.size).toBe(0);
    });

    it('handles symbol with no effects and no type', () => {
      const nifData = makeNifOutput({
        symbols: [makeNifSymbol({ symbol: 'plain' })],
      });
      const result = translateNifToConstraints(nifData);

      expect(result.effects.has('plain')).toBe(false);
      expect(result.typeConstraints.has('plain')).toBe(false);
      expect(result.z3Assertions).toEqual([]);
    });
  });

  describe('effect deduplication', () => {
    it('deduplicates repeated tags within direct efx node', () => {
      // The efx path uses !tags.includes(t) to skip duplicates.
      const sexpr = '(dupFunc (efx gcsafe gcsafe noSideEffect))';
      const result = translateNifToConstraints(sexpr);

      const tags = result.effects.get('dupFunc')!;
      expect(tags.filter((t) => t === 'gcsafe')).toHaveLength(1);
      expect(tags).toContain('noSideEffect');
      // 'efx' tag name is included from the direct efx path
      expect(tags).toContain('efx');
    });

    it('deduplicates effects across pragma and efx paths', () => {
      // Pragma pushes without dedup, but efx/effects paths check !tags.includes(t).
      // Tags collected by pragma appear first, so efx/effects dedup against them.
      const sexpr = '(dupFunc (pragma (efx gcsafe)) (efx gcsafe noSideEffect))';
      const result = translateNifToConstraints(sexpr);

      const tags = result.effects.get('dupFunc')!;
      expect(tags.filter((t) => t === 'gcsafe')).toHaveLength(1);
      expect(tags).toContain('noSideEffect');
    });
  });
});

describe('translateContractToZ3', () => {
  it('always declares a contract constant', () => {
    const contract = makeContract({ id: 'myContract' });
    const assertions = translateContractToZ3(contract);

    expect(assertions[0]).toBe('(declare-const contract_myContract Contract)');
  });

  it('produces positive assertions for allowed effects', () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }, { kind: 'exec' }],
    });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(allowed_effect') && a.includes('"file_read"'))).toBe(true);
    expect(assertions.some((a) => a.includes('(allowed_effect') && a.includes('"exec"'))).toBe(true);
    // Should not contain "not"
    expect(assertions.some((a) => a.includes('(not (allowed_effect'))).toBe(false);
  });

  it('produces negative assertions for prohibited effects', () => {
    const contract = makeContract({
      prohibitedEffects: [{ kind: 'eval' }, { kind: 'dynamic_import' }],
    });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(not (allowed_effect') && a.includes('"eval"'))).toBe(true);
    expect(assertions.some((a) => a.includes('(not (allowed_effect') && a.includes('"dynamic_import"'))).toBe(true);
  });

  it('includes effect_pattern when pattern is specified', () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read', pattern: '*.ts' }],
    });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(effect_pattern') && a.includes('"*.ts"'))).toBe(true);
  });

  it('includes negated effect_pattern for prohibited patterns', () => {
    const contract = makeContract({
      prohibitedEffects: [{ kind: 'file_write', pattern: '*.env' }],
    });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(not (effect_pattern') && a.includes('"*.env"'))).toBe(true);
  });

  it('produces input_type assertion when inputType is set', () => {
    const contract = makeContract({ inputType: 'string' });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(input_type') && a.includes('"string"'))).toBe(true);
  });

  it('produces output_type assertion when outputType is set', () => {
    const contract = makeContract({ outputType: 'string' });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(output_type') && a.includes('"string"'))).toBe(true);
  });

  it('returns only the contract declaration for empty contract', () => {
    const contract = makeContract();
    const assertions = translateContractToZ3(contract);

    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toBe('(declare-const contract_test-contract Contract)');
  });

  it('handles both allowed and prohibited effects', () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read' }],
      prohibitedEffects: [{ kind: 'eval' }],
    });
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('(allowed_effect') && !a.includes('(not'))).toBe(true);
    expect(assertions.some((a) => a.includes('(not (allowed_effect'))).toBe(true);
  });

  it('escapes quotes in contract id', () => {
    const contract = makeContract({ id: 'id with "quotes"' });
    const assertions = translateContractToZ3(contract);

    expect(assertions[0]).toContain('contract_id with \\"quotes\\"');
  });

  it('escapes special characters in pattern strings', () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read', pattern: 'path with "quotes" and \\backslash' }],
    });
    const assertions = translateContractToZ3(contract);

    const patternAssertion = assertions.find((a) => a.includes('(effect_pattern'));
    expect(patternAssertion).toBeDefined();
    expect(patternAssertion).toContain('\\"quotes\\"');
    expect(patternAssertion).toContain('\\\\backslash');
  });

  it('does not include input_type or output_type when undefined', () => {
    const contract = makeContract();
    const assertions = translateContractToZ3(contract);

    expect(assertions.some((a) => a.includes('input_type'))).toBe(false);
    expect(assertions.some((a) => a.includes('output_type'))).toBe(false);
  });

  it('handles contract with all optional fields', () => {
    const contract = makeContract({
      allowedEffects: [{ kind: 'file_read', pattern: '*.nim' }, { kind: 'network' }],
      prohibitedEffects: [{ kind: 'eval' }, { kind: 'spawn', pattern: 'rm -rf' }],
      inputType: 'string',
      outputType: 'int',
    });
    const assertions = translateContractToZ3(contract);

    // 1 declare + 2 allowed + 1 pattern + 2 prohibited + 1 pattern + 1 input + 1 output = 9
    expect(assertions.length).toBe(9);
    expect(assertions[0]).toContain('declare-const');
  });
});

describe('ConstraintSet structure', () => {
  it('source is always "nif" when created from translateNifToConstraints', () => {
    const result = translateNifToConstraints(makeNifOutput());
    expect(result.source).toBe('nif');

    const resultFromStr = translateNifToConstraints('(proc x)');
    expect(resultFromStr.source).toBe('nif');
  });

  it('effects Map keys are function names', () => {
    const nifData = makeNifOutput({
      symbols: [
        makeNifSymbol({ symbol: 'myProc', effectPragma: ['gcsafe'] }),
        makeNifSymbol({ symbol: 'myFunc', effectPragma: ['noSideEffect'] }),
      ],
    });
    const result = translateNifToConstraints(nifData);

    const keys = [...result.effects.keys()];
    expect(keys).toContain('myProc');
    expect(keys).toContain('myFunc');
  });

  it('effects Map values are string arrays of tags', () => {
    const nifData = makeNifOutput({
      symbols: [
        makeNifSymbol({ symbol: 'f', effectPragma: ['gcsafe', 'WriteIOEffect', 'custom'] }),
      ],
    });
    const result = translateNifToConstraints(nifData);

    const tags = result.effects.get('f');
    expect(tags).toBeInstanceOf(Array);
    expect(tags).toHaveLength(3);
    expect(tags).toEqual(['gcsafe', 'WriteIOEffect', 'custom']);
  });

  it('typeConstraints Map keys are function names and values are type strings', () => {
    const nifData = makeNifOutput({
      symbols: [
        makeNifSymbol({ symbol: 'getX', typeSignature: 'int' }),
        makeNifSymbol({ symbol: 'isValid', typeSignature: 'bool' }),
      ],
    });
    const result = translateNifToConstraints(nifData);

    expect(result.typeConstraints.get('getX')).toBe('int');
    expect(result.typeConstraints.get('isValid')).toBe('bool');
  });

  it('z3Assertions are valid S-expression strings', () => {
    const nifData = makeNifOutput({
      symbols: [
        makeNifSymbol({ symbol: 'f', effectPragma: ['gcsafe'], typeSignature: 'bool' }),
      ],
    });
    const result = translateNifToConstraints(nifData);

    for (const assertion of result.z3Assertions) {
      // Every assertion should start with (assert or (declare
      expect(assertion.startsWith('(assert ') || assertion.startsWith('(declare')).toBe(true);
      // Every assertion should have balanced parens
      let depth = 0;
      for (const ch of assertion) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
      expect(depth).toBe(0);
    }
  });
});
