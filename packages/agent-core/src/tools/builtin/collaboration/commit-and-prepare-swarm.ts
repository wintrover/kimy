import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ToolExecution } from '../../../loop/types';
import { createAjvValidateArgs } from '../../args-validator';
import { toInputJsonSchema } from '../../support/input-schema';
import {
  AgentSwarmToolInputSchema,
  type AgentSwarmToolInput,
} from './agent-swarm';
import COMMIT_AND_PREPARE_SWARM_DESCRIPTION from './commit-and-prepare-swarm.md?raw';

export type CommitAndPrepareSwarmInput = AgentSwarmToolInput;

export class CommitAndPrepareSwarmTool implements BuiltinTool<CommitAndPrepareSwarmInput> {
  readonly name = 'CommitAndPrepareSwarm' as const;
  readonly description = COMMIT_AND_PREPARE_SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmToolInputSchema);
  private readonly _validateArgs = createAjvValidateArgs(this.parameters);
  validateArgs(args: unknown) { return this._validateArgs(args); }

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: CommitAndPrepareSwarmInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Committing to swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: 'commit-and-prepare-swarm',
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: CommitAndPrepareSwarmInput) {
    this.agent.agentPhase.transitionToExecution(args);
    return {
      output:
        'Committed to swarm. AgentSwarm is now the only available tool.\n' +
        `Description: ${args.description}\n` +
        'The swarm will launch on the next turn with the parameters you provided.',
    };
  }
}
