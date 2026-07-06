import type { Agent } from '..';
import {
  formatContractConstitution,
  type AgentContract,
  type EffectPragma,
} from './contract-formatters.pure';
import { DynamicInjector } from './injector';

// Re-export types for backward compatibility
export type { AgentContract, EffectPragma };

// ---------------------------------------------------------------------------
// ContractStore — in-memory holder populated by S5 (Symbol Dependency Graph).
// ---------------------------------------------------------------------------

/**
 * Simple, synchronous contract store. The Symbol Dependency Graph MCP
 * (S5) calls {@link ContractStore.setContracts} to publish resolved
 * contracts; the {@link ContractInjector} reads them each step.
 *
 * The store is intentionally stateless beyond the current contract set:
 * S5 pushes a full snapshot on every resolution, so there is no merge or
 * incremental update logic needed here.
 */
export class ContractStore {
  private contracts: readonly AgentContract[] = [];

  /** Replace the full contract set (called by S5 on each resolution). */
  setContracts(contracts: readonly AgentContract[]): void {
    this.contracts = contracts;
  }

  /** Return the current contract set (may be empty). */
  getContracts(): readonly AgentContract[] {
    return this.contracts;
  }

  /** Convenience: are there any contracts? */
  hasContracts(): boolean {
    return this.contracts.length > 0;
  }

  /** Clear all contracts. */
  clear(): void {
    this.contracts = [];
  }
}

// ---------------------------------------------------------------------------
// ContractInjector — DynamicInjector for constitutional-level bindings.
// ---------------------------------------------------------------------------

/**
 * Injects the current set of {@link AgentContract}s into the system prompt
 * as a constitutional-level binding. Contracts describe invariants, effect
 * boundaries, and interface constraints for symbols in the dependency graph.
 *
 * Contracts are injected once per step (when present) and are treated as
 * immutable model instructions — they sit above goals, plan mode, and
 * permission reminders in the priority hierarchy.
 *
 * The injector is gated behind the `contract_injection` experimental flag.
 * When the flag is off, no injection occurs regardless of store content.
 */
export class ContractInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'contract';

  constructor(
    agent: Agent,
    private readonly store: ContractStore,
  ) {
    super(agent);
  }

  protected override getInjection(): string | undefined {
    if (!this.agent.experimentalFlags.enabled('contract_injection')) {
      return undefined;
    }

    const contracts = this.store.getContracts();
    if (contracts.length === 0) return undefined;

    return formatContractConstitution(contracts);
  }
}

