import type { KimiConfig } from './schema';
import { AgentRoles } from './schema';

export interface AgentContext {
  readonly isOrchestrator: boolean;
  readonly role: 'default' | 'orchestrator';
}

export function createAgentContext(config?: KimiConfig, cliOrchestrator?: boolean): AgentContext {
  const isOrchestrator = cliOrchestrator ?? (config?.agentRole === AgentRoles.ORCHESTRATOR);
  return {
    isOrchestrator,
    role: isOrchestrator ? AgentRoles.ORCHESTRATOR : AgentRoles.DEFAULT,
  };
}
