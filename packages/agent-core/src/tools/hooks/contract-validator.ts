import { log } from '../../logging/logger';
import type {
  PrepareToolExecutionHook,
  PrepareToolExecutionResult,
  ToolExecutionHookContext,
} from '../../loop/types';

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** Well-known effect categories emitted by NIF / structural analysis. */
export type EffectKind =
  | 'file_read'
  | 'file_write'
  | 'exec'
  | 'spawn'
  | 'network'
  | 'env_mutation'
  | 'fs_traversal'
  | 'dynamic_import'
  | 'eval'
  | 'protobuf'
  | 'unknown';

/** A single declared effect in a contract specification. */
export interface DeclaredEffect {
  readonly kind: EffectKind;
  /** Glob pattern for file paths, command prefix for exec, or URL pattern for network. */
  readonly pattern?: string | undefined;
  /** Human-readable reason why this effect is declared. */
  readonly reason?: string | undefined;
}

/**
 * AgentContract specifies what an agent-submitted unit of code is allowed
 * and required to do. Contracts are evaluated before execution to enforce
 * deterministic behavior in swarm mode.
 */
export interface AgentContract {
  /** Unique identifier for the contract (e.g. agent profile name). */
  readonly id: string;
  /** Effects the agent is explicitly allowed to produce. */
  readonly allowedEffects: readonly DeclaredEffect[];
  /** Effects the agent must NOT produce. Takes precedence over allowedEffects. */
  readonly prohibitedEffects: readonly DeclaredEffect[];
  /** Expected input type signature (e.g. a JSON-Schema shape or structural fingerprint). */
  readonly inputType?: string | undefined;
  /** Expected output type signature. */
  readonly outputType?: string | undefined;
}

// ---------------------------------------------------------------------------
// Analysis info types
// ---------------------------------------------------------------------------

/** NIF-based (Non-Interference Function) semantic analysis result. */
export interface NifSemanticInfo {
  /** Effect kinds detected by semantic analysis. */
  readonly observedEffects: readonly EffectKind[];
  /** Symbol-level dependencies identified. */
  readonly dependencies: readonly string[];
  /** Whether the code is referentially transparent (no side effects). */
  readonly isReferentiallyTransparent: boolean;
  /** Confidence score [0, 1] for the semantic analysis. */
  readonly confidence: number;
}

/** Tree-sitter structural analysis result. */
export interface TreeSitterStructuralInfo {
  /** AST node types found in the code. */
  readonly nodeTypes: readonly string[];
  /** Import / require statements detected. */
  readonly imports: readonly string[];
  /** Function declarations detected. */
  readonly functionDeclarations: readonly string[];
  /** Whether the code contains mutation or side-effect patterns. */
  readonly hasSideEffects: boolean;
  /** Confidence score [0, 1] for the structural analysis. */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export type ViolationSeverity = 'error' | 'warning' | 'info';

/** A single contract violation detected during validation. */
export interface ContractViolation {
  /** Rule identifier that was violated. */
  readonly rule: string;
  /** Human-readable description. */
  readonly message: string;
  /** Severity of the violation. */
  readonly severity: ViolationSeverity;
  /** Which effect kind triggered the violation, if applicable. */
  readonly effectKind?: EffectKind | undefined;
  /** Evidence string (e.g. detected AST node, dependency name). */
  readonly evidence?: string | undefined;
  /** Which analyzer produced this violation. */
  readonly source: 'nif' | 'structural' | 'type-signature' | 'prohibited-effect';
}

/** Aggregate validation report for a single tool execution. */
export interface ContractValidationReport {
  /** Whether the code complies with all contract rules. */
  readonly valid: boolean;
  /** All violations found (empty array when valid). */
  readonly violations: readonly ContractViolation[];
  /** The contract that was validated against. */
  readonly agentContract: AgentContract;
  /** NIF semantic analysis results. */
  readonly nifInfo: NifSemanticInfo;
  /** Tree-sitter structural analysis results. */
  readonly structuralInfo: TreeSitterStructuralInfo;
  /** Duration of validation in milliseconds. */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Analyzer interfaces (injectable, pluggable)
// ---------------------------------------------------------------------------

/**
 * NIF-based semantic analyzer. Implementations extract semantic information
 * from code using Non-Interference Function analysis.
 */
export interface NifAnalyzer {
  /** Analyze code and return semantic info. */
  analyze(code: string, context: NifAnalysisContext): NifSemanticInfo | undefined;
}

export interface NifAnalysisContext {
  readonly toolName: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

/**
 * Tree-sitter based structural analyzer. Implementations parse code into
 * an AST and extract structural information.
 */
export interface TreeSitterAnalyzer {
  /** Analyze code structure and return structural info. */
  analyze(code: string, context: TreeSitterAnalysisContext): TreeSitterStructuralInfo | undefined;
}

export interface TreeSitterAnalysisContext {
  readonly toolName: string;
  readonly language?: string | undefined;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContractValidatorHookOptions {
  /** NIF semantic analyzer. When omitted, NIF checks are skipped. */
  readonly nifAnalyzer?: NifAnalyzer | undefined;
  /** Tree-sitter structural analyzer. When omitted, structural checks are skipped. */
  readonly structuralAnalyzer?: TreeSitterAnalyzer | undefined;
  /**
   * Contract resolver. Given a tool execution context, returns the applicable
   * contract (if any). When the resolver returns `undefined` for a tool call,
   * that call is not validated.
   */
  readonly resolveContract: (ctx: ToolExecutionHookContext) => AgentContract | undefined;
  /**
   * Severity for violations that would otherwise default to 'warning'.
   * @default 'warning'
   */
  readonly defaultViolationSeverity?: ViolationSeverity | undefined;
  /**
   * When true, the hook returns a `syntheticResult` that short-circuits
   * execution on critical violations. Defaults to `false` (feedback only).
   */
  readonly blockOnCritical?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Well-known rules
// ---------------------------------------------------------------------------

const RULE_EFFECT_NOT_ALLOWED = 'contract.effect-not-allowed';
const RULE_EFFECT_PROHIBITED = 'contract.effect-prohibited';
const RULE_TYPE_MISMATCH = 'contract.type-signature-mismatch';
const RULE_NIF_TRANSPARENCY = 'contract.nif-transparency-violation';
const RULE_STRUCTURAL_SIDE_EFFECTS = 'contract.structural-side-effects';
const RULE_MISSING_REQUIRED_EFFECT = 'contract.missing-required-effect';

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Creates a `prepareToolExecution` hook that validates agent-submitted code
 * against an AgentContract BEFORE execution.
 *
 * The hook combines NIF-based semantic analysis with tree-sitter structural
 * analysis to detect violations. Violations are injected as feedback rather
 * than blocking execution (unless `blockOnCritical` is enabled).
 *
 * @example
 * ```ts
 * const hook = createContractValidatorHook({
 *   resolveContract: (ctx) => contracts.get(ctx.toolCall.name),
 *   nifAnalyzer: myNifAnalyzer,
 *   structuralAnalyzer: myStructuralAnalyzer,
 * });
 *
 * // Register in LoopHooks:
 * // { prepareToolExecution: hook }
 * ```
 */
export function createContractValidatorHook(
  options: ContractValidatorHookOptions,
): PrepareToolExecutionHook {
  const {
    nifAnalyzer,
    structuralAnalyzer,
    resolveContract,
    defaultViolationSeverity = 'warning',
    blockOnCritical = false,
  } = options;

  return async (ctx: ToolExecutionHookContext): Promise<PrepareToolExecutionResult | undefined> => {
    const contract = resolveContract(ctx);
    if (contract === undefined) return undefined;

    const code = extractCodeFromArgs(ctx.args);
    if (code === undefined || code.length === 0) return undefined;

    const report = validateContract(code, contract, ctx, {
      nifAnalyzer,
      structuralAnalyzer,
      defaultViolationSeverity,
    });

    if (report.violations.length === 0) return undefined;

    log.info('contract_validator_violations', {
      toolName: ctx.toolCall.name,
      contractId: contract.id,
      violationCount: report.violations.length,
      durationMs: report.durationMs,
    });

    const criticalViolations = report.violations.filter((v) => v.severity === 'error');
    const hasCritical = criticalViolations.length > 0;

    if (blockOnCritical && hasCritical) {
      return {
        block: true,
        reason: formatViolationSummary(report),
        executionMetadata: report,
      };
    }

    // Inject violation feedback without blocking execution.
    const feedback = formatViolationFeedback(report);
    return {
      reason: feedback,
      executionMetadata: report,
    };
  };
}

// ---------------------------------------------------------------------------
// Internal validation logic
// ---------------------------------------------------------------------------

function validateContract(
  code: string,
  contract: AgentContract,
  ctx: ToolExecutionHookContext,
  options: {
    readonly nifAnalyzer: NifAnalyzer | undefined;
    readonly structuralAnalyzer: TreeSitterAnalyzer | undefined;
    readonly defaultViolationSeverity: ViolationSeverity;
  },
): ContractValidationReport {
  const start = Date.now();
  const violations: ContractViolation[] = [];

  // 1. Run NIF semantic analysis.
  const nifInfo: NifSemanticInfo = options.nifAnalyzer?.analyze(code, {
    toolName: ctx.toolCall.name,
    turnId: ctx.turnId,
    toolCallId: ctx.toolCall.id,
  }) ?? {
    observedEffects: [],
    dependencies: [],
    isReferentiallyTransparent: true,
    confidence: 0,
  };

  // 2. Run tree-sitter structural analysis.
  const structuralInfo: TreeSitterStructuralInfo = options.structuralAnalyzer?.analyze(code, {
    toolName: ctx.toolCall.name,
  }) ?? {
    nodeTypes: [],
    imports: [],
    functionDeclarations: [],
    hasSideEffects: false,
    confidence: 0,
  };

  // 3. Validate effect compliance — check that every observed effect is allowed.
  for (const effect of nifInfo.observedEffects) {
    if (!isEffectAllowed(effect, contract)) {
      violations.push({
        rule: RULE_EFFECT_NOT_ALLOWED,
        message: `Effect "${effect}" is not in the contract's allowed effects list.`,
        severity: options.defaultViolationSeverity,
        effectKind: effect,
        source: 'nif',
      });
    }
  }

  // 4. Validate prohibited effects — ensure no prohibited effect is present.
  for (const prohibited of contract.prohibitedEffects) {
    if (isEffectPresent(prohibited, nifInfo.observedEffects)) {
      violations.push({
        rule: RULE_EFFECT_PROHIBITED,
        message:
          `Prohibited effect "${prohibited.kind}" detected` +
          (prohibited.pattern !== undefined ? ` matching pattern "${prohibited.pattern}"` : '') +
          '.',
        severity: 'error',
        effectKind: prohibited.kind,
        source: 'prohibited-effect',
      });
    }
  }

  // 5. Validate type signatures if declared in the contract.
  if (contract.inputType !== undefined) {
    const typeViolation = validateTypeSignature(
      code,
      contract.inputType,
      'input',
      options.defaultViolationSeverity,
    );
    if (typeViolation !== undefined) {
      violations.push(typeViolation);
    }
  }
  if (contract.outputType !== undefined) {
    const typeViolation = validateTypeSignature(
      code,
      contract.outputType,
      'output',
      options.defaultViolationSeverity,
    );
    if (typeViolation !== undefined) {
      violations.push(typeViolation);
    }
  }

  // 6. Structural analysis cross-checks.
  if (structuralInfo.hasSideEffects && nifInfo.isReferentiallyTransparent) {
    // Structural analysis detects side effects but NIF says transparent — flag as warning.
    violations.push({
      rule: RULE_STRUCTURAL_SIDE_EFFECTS,
      message:
        'Structural analysis detected side-effect patterns but NIF analysis ' +
        'indicates referential transparency. Manual review recommended.',
      severity: 'info',
      source: 'structural',
    });
  }

  if (nifInfo.isReferentiallyTransparent && nifInfo.observedEffects.length === 0) {
    // Code appears purely functional — informational note.
    violations.push({
      rule: RULE_NIF_TRANSPARENCY,
      message: 'Code is referentially transparent with no observed effects.',
      severity: 'info',
      source: 'nif',
    });
  }

  return {
    valid: violations.every((v) => v.severity !== 'error'),
    violations,
    agentContract: contract,
    nifInfo,
    structuralInfo,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Effect matching
// ---------------------------------------------------------------------------

function isEffectAllowed(effect: EffectKind, contract: AgentContract): boolean {
  if (contract.allowedEffects.length === 0) return true;
  return contract.allowedEffects.some((declared) => declared.kind === effect);
}

function isEffectPresent(declared: DeclaredEffect, observed: readonly EffectKind[]): boolean {
  return observed.some((effect) => effect === declared.kind);
}

// ---------------------------------------------------------------------------
// Type signature validation (stub — structural fingerprint matching)
// ---------------------------------------------------------------------------

function validateTypeSignature(
  _code: string,
  _expectedType: string,
  _direction: 'input' | 'output',
  defaultSeverity: ViolationSeverity,
): ContractViolation | undefined {
  // Stub: real implementation would use a type inference engine or
  // structural fingerprint comparison. For now, always passes.
  //
  // Future work: integrate with a lightweight type checker that can
  // validate structural compatibility between declared and inferred types
  // without requiring full compilation.
  return undefined;
}

// ---------------------------------------------------------------------------
// Code extraction from tool call args
// ---------------------------------------------------------------------------

function extractCodeFromArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === 'string') return args;

  if (typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    // Common property names where code payloads live.
    for (const key of ['code', 'command', 'content', 'source', 'script', 'prompt']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Feedback formatting
// ---------------------------------------------------------------------------

function formatViolationSummary(report: ContractValidationReport): string {
  const errorCount = report.violations.filter((v) => v.severity === 'error').length;
  const warningCount = report.violations.filter((v) => v.severity === 'warning').length;
  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${String(errorCount)} error(s)`);
  if (warningCount > 0) parts.push(`${String(warningCount)} warning(s)`);
  return (
    `Contract "${report.agentContract.id}" validation failed: ` +
    `${parts.join(', ')} found in ${String(report.durationMs)}ms.`
  );
}

function formatViolationFeedback(report: ContractValidationReport): string {
  const lines: string[] = [
    `<contract_violations contract="${escapeXmlAttr(report.agentContract.id)}">`,
  ];

  for (const v of report.violations) {
    if (v.severity === 'info') continue;
    const evidence = v.evidence !== undefined ? ` evidence="${escapeXmlAttr(v.evidence)}"` : '';
    const effect = v.effectKind !== undefined ? ` effect="${v.effectKind}"` : '';
    lines.push(
      `  <violation rule="${escapeXmlAttr(v.rule)}" severity="${v.severity}" source="${v.source}"${effect}${evidence}>` +
        escapeXmlContent(v.message) +
        '</violation>',
    );
  }

  lines.push('</contract_violations>');
  return lines.join('\n');
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
