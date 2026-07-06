import type { Agent } from '..';
import type { AgentSwarmToolInput } from '../../tools/builtin/collaboration/agent-swarm';

export const AgentPhaseState = {
  PLANNING: 'planning',
  EXECUTION: 'execution',
} as const;

export type AgentPhaseState = (typeof AgentPhaseState)[keyof typeof AgentPhaseState];

export class AgentPhase {
  private _current: AgentPhaseState = AgentPhaseState.PLANNING;
  private _pendingSwarmParams: AgentSwarmToolInput | null = null;
  private _escapeAttempted = false;

  constructor(protected readonly agent: Agent) {}

  // ── State queries ──
  get current(): AgentPhaseState {
    return this._current;
  }

  get pendingSwarmParams(): AgentSwarmToolInput | null {
    return this._pendingSwarmParams;
  }

  get isExecution(): boolean {
    return this._current === AgentPhaseState.EXECUTION;
  }

  // ── Transitions (atomic: phase + params change simultaneously) ──

  /** Called when CommitAndPrepareSwarm is invoked: planning → execution */
  transitionToExecution(params: AgentSwarmToolInput): void {
    this._current = AgentPhaseState.EXECUTION;
    this._pendingSwarmParams = params;
    this._escapeAttempted = false;
    this.agent.emitStatusUpdated();
  }

  /** Called after AgentSwarm completes or escape guard fires: execution → planning */
  resetToPlanning(): void {
    this._current = AgentPhaseState.PLANNING;
    this._pendingSwarmParams = null;
    this._escapeAttempted = false;
    this.agent.emitStatusUpdated();
  }

  /** Check if escape guard has already been attempted (1-time limit) */
  markEscapeAttempted(): boolean {
    if (this._escapeAttempted) return false;
    this._escapeAttempted = true;
    return true;
  }
}
