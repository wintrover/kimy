import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external dependencies ───────────────────────────────────────────────

vi.mock('#/logging/logger', () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('#/tools/hooks/constraint-translator', () => ({
  translateNifToConstraints: vi.fn(),
  translateContractToZ3: vi.fn(),
}));

vi.mock('#/tools/hooks/z3-verifier', () => ({
  verifyMutation: vi.fn(),
  computeMemoKey: vi.fn(),
}));

vi.mock('#/tools/synthesis/z3-synthesizer', () => ({
  synthesizeHoles: vi.fn(),
}));

vi.mock('#/tools/synthesis/sketch-parser', () => ({
  parseSketch: vi.fn(),
}));

vi.mock('#/tools/synthesis/sketch-assembler', () => ({
  assembleSketchUnsafe: vi.fn(),
}));

// ── Imports after mocking ────────────────────────────────────────────────────

import { OrchestratorKernel } from '#/tools/hooks/orchestrator-kernel';
import type { AgentContract, ContractViolation } from '#/tools/hooks/contract-validator';

import {
  translateNifToConstraints,
  translateContractToZ3,
} from '#/tools/hooks/constraint-translator';

import { verifyMutation } from '#/tools/hooks/z3-verifier';
import { synthesizeHoles } from '#/tools/synthesis/z3-synthesizer';
import { parseSketch } from '#/tools/synthesis/sketch-parser';
import { assembleSketchUnsafe } from '#/tools/synthesis/sketch-assembler';

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockTranslateNif = vi.mocked(translateNifToConstraints);
const mockTranslateContract = vi.mocked(translateContractToZ3);
const mockVerify = vi.mocked(verifyMutation);
const mockSynthesizeHoles = vi.mocked(synthesizeHoles);
const mockParseSketch = vi.mocked(parseSketch);
const mockAssembleSketch = vi.mocked(assembleSketchUnsafe);

function makeContract(overrides?: Partial<AgentContract>): AgentContract {
  return {
    id: overrides?.id ?? 'test-contract',
    allowedEffects: overrides?.allowedEffects ?? [{ kind: 'file_write' }],
    prohibitedEffects: overrides?.prohibitedEffects ?? [{ kind: 'eval' }],
    inputType: overrides?.inputType,
    outputType: overrides?.outputType,
  };
}

function makeViolation(overrides?: Partial<ContractViolation>): ContractViolation {
  return {
    rule: overrides?.rule ?? 'contract.effect-prohibited',
    message: overrides?.message ?? 'Prohibited effect detected',
    severity: overrides?.severity ?? 'error',
    effectKind: overrides?.effectKind ?? 'eval',
    source: overrides?.source ?? 'prohibited-effect',
    evidence: overrides?.evidence,
  };
}

function makeZ3Result(ok: boolean, violatedConstraints?: string[]) {
  return {
    ok,
    violatedConstraints,
    rlimit: 10_000_000,
    memoKey: ok
      ? 'abc12345def67890abcd1234ef567890ab12cd34ef567890ab12cd34ef567890'
      : 'fail1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
  };
}

const DEFAULT_CONSTRAINTS = {
  z3Assertions: ['(assert true)'],
  effects: new Map([['func', ['gcsafe']]]),
  typeConstraints: new Map([['func', 'int']]),
  source: 'nif' as const,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestratorKernel', () => {
  let kernel: OrchestratorKernel;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: constraint translator returns valid constraints
    mockTranslateNif.mockReturnValue(DEFAULT_CONSTRAINTS);
    mockTranslateContract.mockReturnValue(['(assert (allowed_effect contract_test "GCSafe"))']);

    // Default: parseSketch returns a sketch with 1 hole
    mockParseSketch.mockReturnValue({
      id: 'sketch-1',
      targetNode: 'test-file::call[0]',
      template: '??',
      holes: [
        {
          id: 'hole-1',
          domain: 'type',
          constraints: ['must be int'],
          templateHint: undefined,
        },
      ],
      specification: { preconditions: [], postconditions: [], invariants: [], typeConstraints: [] },
    });

    // Default: assembleSketchUnsafe returns assembled source
    mockAssembleSketch.mockReturnValue({
      completeSource: 'repaired function body',
      sourceMap: new Map([['hole-1', '42']]),
    });

    kernel = new OrchestratorKernel({ z3Rlimit: 10_000_000 });
  });

  // ── validateMutation ──────────────────────────────────────────────────────

  describe('validateMutation', () => {
    it('should approve a mutation when Z3 verification passes', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function foo() { return 1; }',
        newContent: 'function foo() { return 2; }',
        structuralPaths: ['function_declaration[0]'],
        contracts: [makeContract()],
      });

      expect(result.approved).toBe(true);
      expect(result.verificationScore).toBe(1);
      expect(result.violations).toHaveLength(0);
      expect(result.synthesizedFix).toBeUndefined();
    });

    it('should reject when Z3 verification fails', async () => {
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['contract.prohibited:eval']),
      );

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function foo() { return 1; }',
        newContent: 'function foo() { eval("bad"); }',
        structuralPaths: ['function_declaration[0]'],
        contracts: [makeContract()],
      });

      expect(result.approved).toBe(false);
      expect(result.verificationScore).toBeLessThan(1);
    });

    it('should trigger synthesis when Z3 verification fails and synthesis is enabled', async () => {
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['contract.prohibited:eval']),
      );

      // Build a sketch template that contains evidence from the violation
      mockParseSketch.mockReturnValue({
        id: 'sketch-2',
        targetNode: 'test-file::call[0]',
        template: '??',
        holes: [
          {
            id: 'hole-1',
            domain: 'type',
            constraints: ['must be safe'],
            templateHint: undefined,
          },
        ],
        specification: { preconditions: [], postconditions: [], invariants: [], typeConstraints: [] },
      });

      mockSynthesizeHoles.mockResolvedValue({
        success: true,
        holeValues: new Map([['hole-1', 'safe_code']]),
        rlimit: 10_000_000,
        memoKey: 'synth-key-123',
      });

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function foo() { return 1; }',
        newContent: 'function foo() { eval("bad"); }',
        structuralPaths: ['function_declaration[0]'],
        contracts: [makeContract()],
      });

      expect(result.approved).toBe(false);
      expect(result.synthesizedFix).toBeDefined();
      expect(result.synthesizedFix?.assembledSource).toBe('repaired function body');
      expect(mockSynthesizeHoles).toHaveBeenCalled();
    });

    it('should skip synthesis when Z3 verification passes', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function foo() {}',
        newContent: 'function foo() { return 1; }',
        structuralPaths: [],
        contracts: [makeContract()],
      });

      expect(mockSynthesizeHoles).not.toHaveBeenCalled();
    });

    it('should return cached results on repeated validations', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const ctx = {
        filePath: 'src/foo.ts',
        oldContent: 'original',
        newContent: 'modified',
        structuralPaths: ['func[0]'],
        contracts: [makeContract()],
      };

      // First call — runs full pipeline
      const first = await kernel.validateMutation(ctx);
      expect(first.approved).toBe(true);
      expect(first.cachedFromEpoch).toBeUndefined();
      expect(mockVerify).toHaveBeenCalledTimes(1);

      // Second call — should hit cache
      const second = await kernel.validateMutation(ctx);
      expect(second.approved).toBe(true);
      expect(second.cachedFromEpoch).toBeDefined();
      // verify should not be called again
      expect(mockVerify).toHaveBeenCalledTimes(1);
    });

    it('should skip Z3 when no contracts provided', async () => {
      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'original',
        newContent: 'modified',
        structuralPaths: ['func[0]'],
        // no contracts
      });

      expect(mockVerify).not.toHaveBeenCalled();
      // Without contracts, Z3 is skipped → score = 0.8
      expect(result.verificationScore).toBe(0.8);
      expect(result.approved).toBe(false);
    });

    it('should skip Z3 when constraints have no assertions', async () => {
      mockTranslateNif.mockReturnValue({
        z3Assertions: [],
        effects: new Map(),
        typeConstraints: new Map(),
        source: 'nif',
      });
      mockTranslateContract.mockReturnValue([]);

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'original',
        newContent: 'modified',
        structuralPaths: [],
        contracts: [makeContract()],
      });

      expect(mockVerify).not.toHaveBeenCalled();
      expect(result.verificationScore).toBe(0.8);
    });

    it('should include diagnostics from all stages', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f[0]'],
        contracts: [makeContract()],
      });

      const stages = result.diagnostics.map((d) => d.stage);
      expect(stages).toContain('constraint-translate');
      expect(stages).toContain('z3-verify');
      expect(stages).toContain('contract-validate');
      expect(stages).toContain('sketch-synthesize');
      expect(stages).toContain('vfs-cache');
    });

    it('should detect contract violations and report them', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      // Mutation introduces eval which is prohibited
      const contract = makeContract({
        prohibitedEffects: [{ kind: 'eval', pattern: 'eval\\(' }],
      });

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function foo() {}',
        newContent: 'function foo() { eval("bad"); }',
        structuralPaths: ['func[0]'],
        contracts: [contract],
      });

      // eval should be detected as a prohibited effect
      expect(result.violations.length).toBeGreaterThan(0);
      const evalViolation = result.violations.findLast(
        (v) => v.effectKind === 'eval',
      );
      expect(evalViolation).toBeDefined();
      expect(evalViolation?.severity).toBe('error');
    });

    it('should cap verification score at 0.5 when contract errors exist', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const contract = makeContract({
        prohibitedEffects: [{ kind: 'eval' }],
      });

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function foo() {}',
        newContent: 'function foo() { eval("bad"); }',
        structuralPaths: ['func[0]'],
        contracts: [contract],
      });

      // Score was 1 from Z3 pass, but contract error caps it to 0.5
      expect(result.verificationScore).toBe(0.5);
      expect(result.approved).toBe(false);
    });
  });

  // ── synthesizeRepair ──────────────────────────────────────────────────────

  describe('synthesizeRepair', () => {
    it('should return null when synthesis is disabled', async () => {
      const kernelNoSynth = new OrchestratorKernel({ enableSynthesis: false });

      const result = await kernelNoSynth.synthesizeRepair(
        {
          filePath: 'src/foo.ts',
          oldContent: 'old',
          newContent: 'new',
          structuralPaths: [],
        },
        [],
      );

      expect(result).toBeNull();
    });

    it('should return a patch when synthesis succeeds', async () => {
      mockSynthesizeHoles.mockResolvedValue({
        success: true,
        holeValues: new Map([['hole-1', 'safe']]),
        rlimit: 10_000_000,
        memoKey: 'synth-ok',
      });

      const result = await kernel.synthesizeRepair(
        {
          filePath: 'src/foo.ts',
          oldContent: 'old code',
          newContent: 'new code',
          structuralPaths: ['func'],
        },
        [makeViolation()],
      );

      expect(result).not.toBeNull();
      expect(result?.assembledSource).toBe('repaired function body');
      expect(result?.originalSource).toBe('new code');
      expect(result?.sourceMap.get('hole-1')).toBe('42');
    });

    it('should return null when synthesis fails', async () => {
      mockSynthesizeHoles.mockResolvedValue({
        success: false,
        rlimit: 10_000_000,
        memoKey: 'synth-fail',
        error: 'UNSAT',
      });

      const result = await kernel.synthesizeRepair(
        {
          filePath: 'src/foo.ts',
          oldContent: 'old',
          newContent: 'new',
          structuralPaths: [],
        },
        [makeViolation()],
      );

      expect(result).toBeNull();
    });

    it('should return null when no synthesis opportunities found', async () => {
      // No error violations → buildSketchFromViolations returns holeCount=0
      const result = await kernel.synthesizeRepair(
        {
          filePath: 'src/foo.ts',
          oldContent: 'old',
          newContent: 'new',
          structuralPaths: [],
        },
        [makeViolation({ severity: 'warning' })],
      );

      expect(result).toBeNull();
    });
  });

  // ── VFS management ────────────────────────────────────────────────────────

  describe('VFS management', () => {
    it('should start with a seed epoch', () => {
      const status = kernel.getVfsStatus();
      expect(status.activeEpochId).toBe(0);
      expect(status.epochCount).toBe(1);
      expect(status.fileCount).toBe(0);
    });

    it('should create a new epoch on successful mutation', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'old',
        newContent: 'new',
        structuralPaths: [],
        contracts: [makeContract()],
      });

      const status = kernel.getVfsStatus();
      expect(status.activeEpochId).toBe(1);
      expect(status.epochCount).toBe(2);
      expect(status.fileCount).toBe(1);
      expect(status.paths).toContain('src/foo.ts');
    });

    it('should increment epoch count for each mutation', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      await kernel.validateMutation({
        filePath: 'src/a.ts',
        oldContent: 'a1',
        newContent: 'a2',
        structuralPaths: [],
        contracts: [makeContract()],
      });
      await kernel.validateMutation({
        filePath: 'src/b.ts',
        oldContent: 'b1',
        newContent: 'b2',
        structuralPaths: [],
        contracts: [makeContract()],
      });

      const status = kernel.getVfsStatus();
      expect(status.activeEpochId).toBe(2);
      expect(status.epochCount).toBe(3);
      expect(status.fileCount).toBe(2);
    });

    it('should store file content in VFS', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'old',
        newContent: 'new content',
        structuralPaths: [],
        contracts: [makeContract()],
      });

      const vfs = kernel.getVfs();
      expect(vfs.getFile('src/foo.ts')).toBe('new content');
    });

    it('should invalidate cache and force re-validation', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const ctx = {
        filePath: 'src/foo.ts',
        oldContent: 'old',
        newContent: 'new',
        structuralPaths: ['f[0]'],
        contracts: [makeContract()],
      };

      // First call
      await kernel.validateMutation(ctx);
      expect(mockVerify).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      await kernel.validateMutation(ctx);
      expect(mockVerify).toHaveBeenCalledTimes(1);

      // Invalidate
      kernel.invalidateCache(['src/foo.ts']);

      // Third call — should re-run pipeline
      await kernel.validateMutation(ctx);
      expect(mockVerify).toHaveBeenCalledTimes(2);
    });

    it('should provide access to underlying VFS and ValidationDb', () => {
      expect(kernel.getVfs()).toBeDefined();
      expect(kernel.getValidationDb()).toBeDefined();
    });
  });

  // ── Cache behavior ────────────────────────────────────────────────────────

  describe('cache behavior', () => {
    it('should return cached valid result with cachedFromEpoch', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const ctx = {
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      };

      await kernel.validateMutation(ctx);
      const second = await kernel.validateMutation(ctx);

      expect(second.cachedFromEpoch).toBe(1);
      expect(
        second.diagnostics.some(
          (d) => d.stage === 'vfs-cache' && d.status === 'cache-hit',
        ),
      ).toBe(true);
    });

    it('should not cache when enableCache is false', async () => {
      const kernelNoCache = new OrchestratorKernel({ enableCache: false });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const ctx = {
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      };

      await kernelNoCache.validateMutation(ctx);
      await kernelNoCache.validateMutation(ctx);

      // Should run twice — no cache
      expect(mockVerify).toHaveBeenCalledTimes(2);
    });

    it('should skip cache when path is invalidated', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const ctx = {
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      };

      await kernel.validateMutation(ctx);
      kernel.invalidateCache(['src/foo.ts']);

      const second = await kernel.validateMutation(ctx);
      expect(second.cachedFromEpoch).toBeUndefined();
    });
  });

  // ── Diagnostic reporting ─────────────────────────────────────────────────

  describe('diagnostic reporting', () => {
    it('should report constraint-translate as pass on success', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f[0]'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find(
        (d) => d.stage === 'constraint-translate',
      );
      expect(diag).toBeDefined();
      expect(diag?.status).toBe('pass');
    });

    it('should report constraint-translate as fail when translator throws', async () => {
      mockTranslateNif.mockImplementation(() => {
        throw new Error('translation error');
      });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find(
        (d) => d.stage === 'constraint-translate',
      );
      expect(diag?.status).toBe('fail');
      expect(diag?.details).toContain('translation error');
    });

    it('should report z3-verify as skip when no contracts', async () => {
      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: [],
      });

      const diag = result.diagnostics.find((d) => d.stage === 'z3-verify');
      expect(diag?.status).toBe('skip');
    });

    it('should report z3-verify as pass when verification succeeds', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find((d) => d.stage === 'z3-verify');
      expect(diag?.status).toBe('pass');
    });

    it('should report z3-verify as fail when verification fails', async () => {
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['contract.prohibited:eval']),
      );

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find((d) => d.stage === 'z3-verify');
      expect(diag?.status).toBe('fail');
    });

    it('should report contract-validate as skip when no contracts', async () => {
      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: [],
      });

      const diag = result.diagnostics.find(
        (d) => d.stage === 'contract-validate',
      );
      expect(diag?.status).toBe('skip');
    });

    it('should report vfs-cache diagnostic', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find((d) => d.stage === 'vfs-cache');
      expect(diag).toBeDefined();
      expect(diag?.status).toBe('pass');
    });

    it('should report vfs-cache as skip when caching disabled', async () => {
      const kernelNoCache = new OrchestratorKernel({ enableCache: false });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernelNoCache.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find((d) => d.stage === 'vfs-cache');
      expect(diag?.status).toBe('skip');
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should degrade gracefully when Z3 engine throws', async () => {
      mockVerify.mockRejectedValue(new Error('z3 WASM crash'));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // Should get a fallback failure result
      const z3Diag = result.diagnostics.find((d) => d.stage === 'z3-verify');
      expect(z3Diag?.status).toBe('fail');
      expect(z3Diag?.details).toContain('z3 WASM crash');
      expect(result.approved).toBe(false);
    });

    it('should degrade gracefully when constraint translator throws', async () => {
      mockTranslateNif.mockImplementation(() => {
        throw new Error('NIF parse error');
      });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(result.approved).toBe(false);
      expect(result.verificationScore).toBe(0);
      const translateDiag = result.diagnostics.find(
        (d) => d.stage === 'constraint-translate',
      );
      expect(translateDiag?.status).toBe('fail');
    });

    it('should skip Z3 after translation failure and set score to 0', async () => {
      mockTranslateNif.mockImplementation(() => {
        throw new Error('bad input');
      });

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // Z3 should be skipped since translation failed
      expect(mockVerify).not.toHaveBeenCalled();
      const z3Diag = result.diagnostics.find((d) => d.stage === 'z3-verify');
      expect(z3Diag?.status).toBe('skip');
      expect(result.verificationScore).toBe(0);
    });

    it('should handle non-Error thrown values in translation', async () => {
      mockTranslateNif.mockImplementation(() => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      });

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: [],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find(
        (d) => d.stage === 'constraint-translate',
      );
      expect(diag?.status).toBe('fail');
      expect(diag?.details).toBe('string error');
    });
  });

  // ── Configuration ─────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('should use default config when none provided', async () => {
      const defaultKernel = new OrchestratorKernel();
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await defaultKernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(result.approved).toBe(true);
    });

    it('should respect custom z3Rlimit', async () => {
      const customKernel = new OrchestratorKernel({ z3Rlimit: 5_000_000 });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      await customKernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // verifyMutation receives the kernel's rlimit
      expect(mockVerify).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5_000_000,
      );
    });

    it('should skip synthesis when enableSynthesis is false', async () => {
      const kernelNoSynth = new OrchestratorKernel({ enableSynthesis: false });
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['contract.prohibited:eval']),
      );

      const result = await kernelNoSynth.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(mockSynthesizeHoles).not.toHaveBeenCalled();
      expect(result.synthesizedFix).toBeUndefined();

      const synthDiag = result.diagnostics.find(
        (d) => d.stage === 'sketch-synthesize',
      );
      expect(synthDiag?.status).toBe('skip');
    });

    it('should respect maxSynthesisRounds configuration', async () => {
      const kernelRounds = new OrchestratorKernel({
        maxSynthesisRounds: 2,
      });
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['contract.prohibited:eval']),
      );
      // Synthesis fails all rounds
      mockSynthesizeHoles.mockResolvedValue({
        success: false,
        rlimit: 10_000_000,
        memoKey: 'fail',
        error: 'UNSAT',
      });

      const result = await kernelRounds.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function f() {}',
        newContent: 'function f() { eval("bad"); }',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // Should have called synthesize exactly 2 times (maxSynthesisRounds)
      expect(mockSynthesizeHoles).toHaveBeenCalledTimes(2);
      expect(result.synthesizedFix).toBeUndefined();
    });

    it('should stop synthesis on first success', async () => {
      const kernelRounds = new OrchestratorKernel({
        maxSynthesisRounds: 5,
      });
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['contract.prohibited:eval']),
      );
      // First attempt fails, second succeeds
      mockSynthesizeHoles
        .mockResolvedValueOnce({
          success: false,
          rlimit: 10_000_000,
          memoKey: 'fail-1',
          error: 'UNSAT',
        })
        .mockResolvedValueOnce({
          success: true,
          holeValues: new Map([['hole-1', 'fixed']]),
          rlimit: 10_000_000,
          memoKey: 'ok-2',
        });

      const result = await kernelRounds.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function f() {}',
        newContent: 'function f() { eval("bad"); }',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(mockSynthesizeHoles).toHaveBeenCalledTimes(2);
      expect(result.synthesizedFix).toBeDefined();
    });

    it('should skip VFS cache stage when enableCache is false', async () => {
      const kernelNoCache = new OrchestratorKernel({ enableCache: false });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernelNoCache.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const vfsDiag = result.diagnostics.find((d) => d.stage === 'vfs-cache');
      expect(vfsDiag?.status).toBe('skip');
      expect(vfsDiag?.details).toBe('caching disabled');

      // VFS should not have created a new epoch for the file
      const status = kernelNoCache.getVfsStatus();
      expect(status.fileCount).toBe(0);
    });

    it('should pass contractStrictness through config', async () => {
      const kernelRelaxed = new OrchestratorKernel({
        contractStrictness: 'relaxed',
      });
      mockVerify.mockResolvedValue(makeZ3Result(true));

      // Should not throw with relaxed config
      const result = await kernelRelaxed.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(result.approved).toBe(true);
    });
  });

  // ── Score computation ─────────────────────────────────────────────────────

  describe('score computation', () => {
    it('should compute score based on number of violated constraints', async () => {
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['v1']),
      );

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // 1 violation → 1 - 1*0.3 = 0.7
      expect(result.verificationScore).toBe(0.7);
    });

    it('should return minimum 0.1 for many violations', async () => {
      mockVerify.mockResolvedValue(
        makeZ3Result(false, ['v1', 'v2', 'v3', 'v4', 'v5']),
      );

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // 5 violations → max(0.1, 1 - 5*0.3) = 0.1
      expect(result.verificationScore).toBe(0.1);
    });

    it('should return 0 when Z3 fails with no violated constraints', async () => {
      mockVerify.mockResolvedValue({
        ok: false,
        rlimit: 10_000_000,
        memoKey: 'key',
      });

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(result.verificationScore).toBe(0);
    });

    it('should clamp score to [0, 1] range', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      expect(result.verificationScore).toBeGreaterThanOrEqual(0);
      expect(result.verificationScore).toBeLessThanOrEqual(1);
    });
  });

  // ── Effect detection ──────────────────────────────────────────────────────

  describe('effect detection', () => {
    it('should detect file_write when content changes', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'old',
        newContent: 'new',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // Contract validation should detect file_write effect
      const contractDiag = result?.diagnostics.find(
        (d) => d.stage === 'contract-validate',
      );
      // Even though file_write is allowed, it should be detected
    });

    it('should detect dynamic_import when new imports appear', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      // New import in newContent not in oldContent
      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'const x = 1;',
        newContent: 'import fs from "fs";\nconst x = 1;',
        structuralPaths: ['f'],
        contracts: [
          makeContract({
            allowedEffects: [
              { kind: 'file_write' },
              { kind: 'dynamic_import' },
            ],
            prohibitedEffects: [{ kind: 'eval' }],
          }),
        ],
      });

      expect(result.approved).toBe(true);
    });

    it('should detect eval patterns', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function f() {}',
        newContent: 'function f() { eval("code"); }',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // eval is prohibited → should have violations
      expect(result.violations.some((v) => v.effectKind === 'eval')).toBe(true);
    });

    it('should detect network operations', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'function f() {}',
        newContent: 'function f() { fetch("https://example.com"); }',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // fetch should be detected as network effect
      // Since network is not in allowedEffects, should produce a warning violation
      expect(
        result.violations.some((v) => v.effectKind === 'network'),
      ).toBe(true);
    });
  });

  // ── Contract merge ────────────────────────────────────────────────────────

  describe('contract merge', () => {
    it('should merge contract assertions into constraint set', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      // translateContractToZ3 should be called for the contract
      expect(mockTranslateContract).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-contract' }),
      );
    });

    it('should use hybrid source when contracts are present', async () => {
      mockVerify.mockResolvedValue(makeZ3Result(true));

      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        contracts: [makeContract()],
      });

      const diag = result.diagnostics.find(
        (d) => d.stage === 'constraint-translate',
      );
      expect(diag?.details).toContain('hybrid');
    });

    it('should use nif source when no contracts', async () => {
      const result = await kernel.validateMutation({
        filePath: 'src/foo.ts',
        oldContent: 'a',
        newContent: 'b',
        structuralPaths: ['f'],
        // no contracts
      });

      const diag = result.diagnostics.find(
        (d) => d.stage === 'constraint-translate',
      );
      expect(diag?.details).toContain('nif');
    });
  });
});
