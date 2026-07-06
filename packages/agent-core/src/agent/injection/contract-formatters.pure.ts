// ---------------------------------------------------------------------------
// Pure contract formatters — no side effects, no I/O.
// Extracted from contract-injector.ts for Z3-friendly analysis.
//
// Principles applied:
//   A: Total — null/undefined/empty → ''
//   B: AST-friendly — Array.join('') and + only, no template literals
//   C: Data, not code — returns plain strings
//   D: Effect markers — pure string returns, no markers needed
// ---------------------------------------------------------------------------

/** Side-effect tag describing a capability or I/O boundary a symbol touches. */
export type EffectPragma =
  | 'pure'
  | 'io'
  | 'network'
  | 'fs-read'
  | 'fs-write'
  | 'process-spawn'
  | 'mutation'
  | 'async'
  | string;

/**
 * A single contract entry for one symbol. Describes what the symbol is, what
 * it may and may not do, and its durability guarantees.
 */
export interface AgentContract {
  /** Fully-qualified symbol name, e.g. `packages/agent-core/src/agent/index.ts:Agent` */
  readonly symbol: string;

  /** Human-readable type signature, e.g. `(x: number) => Promise<void>` */
  readonly typeSignature: string;

  /** Declared effect pragma(s) — what the symbol is allowed to do. */
  readonly effectPragma: EffectPragma[];

  /** Effects the symbol is forbidden from performing. */
  readonly prohibitedEffects: EffectPragma[];

  /** Fields / methods that may be mutated at runtime. */
  readonly mutableInterface: readonly string[];

  /** Fields / methods that must never be mutated. */
  readonly immutableInterface: readonly string[];

  /** Free-form invariants the model must preserve (e.g. "transaction must commit"). */
  readonly invariants: readonly string[];

  /** Durability class: `transient` | `session` | `persistent` */
  readonly durability: 'transient' | 'session' | 'persistent';
}

/**
 * Render the contract set as a single system-prompt block.
 *
 * Format:
 * ```
 * ## Contract (Constitution)
 *
 * You MUST comply with these contracts...
 * ```
 */
export function formatContractConstitution(
  contracts: readonly AgentContract[] | null | undefined,
): string {
  if (!contracts || contracts.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Contract (Constitution)');
  lines.push('');
  lines.push(
    'You MUST comply with these contracts. They are immutable invariants ' +
      'that supersede all other instructions when they conflict. Do not ' +
      'violate any contract below — if a task requires a prohibited effect, ' +
      'report the conflict instead of proceeding.',
  );
  lines.push('');

  for (const contract of contracts) {
    lines.push(formatSingleContract(contract));
  }

  return lines.join('\n');
}

export function formatSingleContract(c: AgentContract | null | undefined): string {
  if (!c) {
    return '';
  }

  const lines: string[] = [];

  lines.push('### ' + c.symbol);
  lines.push('');
  lines.push('- **Signature:** `' + c.typeSignature + '`');
  lines.push('- **Durability:** ' + c.durability);

  if (c.effectPragma.length > 0) {
    lines.push('- **Allowed effects:** ' + c.effectPragma.join(', '));
  }

  if (c.prohibitedEffects.length > 0) {
    lines.push('- **Prohibited effects:** ' + c.prohibitedEffects.join(', '));
  }

  if (c.mutableInterface.length > 0) {
    lines.push('- **Mutable:** ' + c.mutableInterface.join(', '));
  }

  if (c.immutableInterface.length > 0) {
    lines.push('- **Immutable:** ' + c.immutableInterface.join(', '));
  }

  if (c.invariants.length > 0) {
    lines.push('- **Invariants:**');
    for (const inv of c.invariants) {
      lines.push('  - ' + inv);
    }
  }

  return lines.join('\n');
}
