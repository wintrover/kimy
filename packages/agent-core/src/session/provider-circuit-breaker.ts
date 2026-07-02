export type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  openedAt: number;
}

export class ProviderCircuitBreaker {
  private readonly circuits = new Map<string, CircuitEntry>();
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;

  constructor(options?: {
    readonly failureThreshold?: number;
    readonly openDurationMs?: number;
  }) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.openDurationMs = options?.openDurationMs ?? 5 * 60_000;
  }

  getState(providerId: string): CircuitState {
    const entry = this.circuits.get(providerId);
    if (!entry || entry.state === 'closed') return 'closed';
    if (entry.state === 'open' && Date.now() - entry.openedAt >= this.openDurationMs) {
      return 'half_open';
    }
    return entry.state;
  }

  getAllStates(): ReadonlyMap<string, CircuitState> {
    const result = new Map<string, CircuitState>();
    for (const [id] of this.circuits) {
      result.set(id, this.getState(id));
    }
    return result;
  }

  recordSuccess(providerId: string): void {
    this.circuits.delete(providerId);
  }

  recordFailure(providerId: string): void {
    let entry = this.circuits.get(providerId);
    if (!entry) {
      entry = { state: 'closed', failureCount: 0, openedAt: 0 };
      this.circuits.set(providerId, entry);
    }
    entry.failureCount++;
    if (
      entry.failureCount >= this.failureThreshold ||
      entry.state === 'half_open'
    ) {
      entry.state = 'open';
      entry.openedAt = Date.now();
    }
  }

  /** Immediately open the circuit, bypassing failure threshold. */
  forceOpen(providerId: string): void {
    let entry = this.circuits.get(providerId);
    if (!entry) {
      entry = { state: 'closed', failureCount: 0, openedAt: 0 };
      this.circuits.set(providerId, entry);
    }
    entry.state = 'open';
    entry.openedAt = Date.now();
    entry.failureCount = this.failureThreshold;
  }
}
