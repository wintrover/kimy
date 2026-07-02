import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { ToolAccesses } from '../../../loop/tool-access';
import { createAjvValidateArgs } from '../../args-validator';
import { toInputJsonSchema } from '../../support/input-schema';
import SAVE_PLAN_DESCRIPTION from './save-plan.md?raw';

export const SavePlanInputSchema = z.object({
  content: z.string().describe('The markdown content of the plan to save.'),
});
export type SavePlanInput = z.Infer<typeof SavePlanInputSchema>;

export class SavePlanTool implements BuiltinTool<SavePlanInput> {
  readonly name = 'SavePlan' as const;
  readonly description = SAVE_PLAN_DESCRIPTION;
  readonly parameters = toInputJsonSchema(SavePlanInputSchema);
  private readonly _validateArgs = createAjvValidateArgs(this.parameters);
  validateArgs(args: unknown) { return this._validateArgs(args); }

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: SavePlanInput): ToolExecution {
    const planFilePath = this.agent.planMode.planFilePath;
    if (!planFilePath) {
      throw new Error('Plan file path is not initialized. EnterPlanMode must be called first.');
    }
    const plansDir = this.agent.planMode.plansDir;

    return {
      description: 'Saving plan file',
      approvalRule: this.name,
      accesses: ToolAccesses.writeFile(planFilePath),
      execute: async () => {
        if (!this.agent.planMode.isActive) {
          return { output: 'Error: SavePlan can only be used when plan mode is active. Call EnterPlanMode first.', isError: true };
        }
        const canonicalPlanPath = resolve(planFilePath);
        const canonicalPlansDir = resolve(plansDir);
        const plansDirWithTrailing = canonicalPlansDir.endsWith(sep) ? canonicalPlansDir : canonicalPlansDir + sep;
        if (!canonicalPlanPath.startsWith(plansDirWithTrailing)) {
          return { output: `Error: Security violation. Plan file must reside strictly inside ${plansDir}`, isError: true };
        }
        try {
          await this.agent.kaos.writeText(planFilePath, args.content);
          return { output: `Plan saved to ${planFilePath}`, isError: false };
        } catch (error) {
          return { output: `Error saving plan: ${error}`, isError: true };
        }
      },
    };
  }
}
