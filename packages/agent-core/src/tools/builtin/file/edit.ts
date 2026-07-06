/**
 * EditTool — exact string replacement or structural AST mutation in a file.
 *
 * **String-replace mode** (default): replaces the first occurrence of
 * `old_string` with `new_string`. When `replace_all` is true, replaces
 * all occurrences. Errors when `old_string` is not found or not unique
 * (when `replace_all=false`).
 *
 * **Structural-mutation mode**: applies content-addressed AST node
 * patches via tree-sitter. Enabled by passing `mutations` instead of
 * `old_string`/`new_string`.
 *
 * Path access policy is resolved before any Kaos I/O.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { createAjvValidateArgs } from '../../args-validator';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { materializeModelText, toModelTextView } from './line-endings';
import {
  StructuralASTMutationSchema,
  type StructuralASTMutation,
  applyStructuralMutations,
  StructuralMutationError,
} from './structural-mutation';
import EDIT_DESCRIPTION from './edit.md?raw';

const PATH_DESC =
  'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.';

/**
 * String-replace input — the original EditTool interface.
 */
const StringReplaceInputSchema = z.object({
  path: z.string().describe(PATH_DESC),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.',
    ),
  new_string: z
    .string()
    .describe(
      'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.',
    ),
  replace_all: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of old_string should be replaced.'),
});

/**
 * Structural AST mutation input — new mode powered by content-addressed
 * node IDs and tree-sitter.
 */
const StructuralMutationInputSchema = z.object({
  path: z.string().describe(PATH_DESC),
  mutations: z
    .array(StructuralASTMutationSchema)
    .min(1)
    .max(64)
    .describe(
      'Array of structural AST mutations. Each targets a node by its ' +
        'content-addressed ID (from a previous AST analysis) and applies ' +
        'a text replacement. Mutations are applied atomically.',
    ),
});

/**
 * Discriminated union of both input modes.  The union is resolved at
 * runtime: if `mutations` is present, the structural-mutation path is
 * taken; otherwise the string-replace path is used.
 */
export const EditInputSchema = z.union([
  StringReplaceInputSchema,
  StructuralMutationInputSchema,
]);

export type EditInput = z.Infer<typeof EditInputSchema>;

/** Type guard: structural-mutation input mode. */
function isStructuralMutationInput(
  args: EditInput,
): args is z.infer<typeof StructuralMutationInputSchema> {
  return 'mutations' in args;
}

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);
  private readonly _validateArgs = createAjvValidateArgs(this.parameters);
  validateArgs(args: unknown) { return this._validateArgs(args); }

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });

    if (isStructuralMutationInput(args)) {
      const mutationCount = args.mutations.length;
      return {
        accesses: ToolAccesses.readWriteFile(path),
        description: `Editing ${args.path} (${String(mutationCount)} structural mutation${mutationCount === 1 ? '' : 's'})`,
        display: {
          kind: 'file_io',
          operation: 'edit',
          path,
        },
        approvalRule: literalRulePattern(this.name, path),
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, path, {
            cwd: this.workspace.workspaceDir,
            pathClass: this.kaos.pathClass(),
            homeDir: this.kaos.gethome(),
          }),
        execute: () => this.executionStructuralMutation(args, path),
      };
    }

    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: () => this.executionStringReplace(args, path),
    };
  }

  /**
   * Execute a structural AST mutation. Reads the file, delegates to
   * `applyStructuralMutations`, and writes the result back.
   */
  private async executionStructuralMutation(
    args: z.infer<typeof StructuralMutationInputSchema>,
    safePath: string,
  ): Promise<ExecutableToolResult> {
    try {
      const raw = await this.kaos.readText(safePath);
      const modelView = toModelTextView(raw);

      const result = await applyStructuralMutations(
        modelView.text,
        args.path,
        args.mutations,
      );

      await this.kaos.writeText(
        safePath,
        materializeModelText(result, modelView.lineEndingStyle),
      );

      return {
        output:
          `Applied ${String(args.mutations.length)} structural mutation${args.mutations.length === 1 ? '' : 's'} to ${args.path}`,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      if (error instanceof StructuralMutationError) {
        return { isError: true, output: error.message };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a string-replace edit (the original EditTool behaviour).
   */
  private async executionStringReplace(
    args: z.infer<typeof StringReplaceInputSchema>,
    safePath: string,
  ): Promise<ExecutableToolResult> {
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    try {
      const raw = await this.kaos.readText(safePath);
      const modelView = toModelTextView(raw);
      const content = modelView.text;
      const replaceAll = args.replace_all ?? false;

      if (!replaceAll) {
        let count = 0;
        let pos = 0;
        while (pos < content.length) {
          const idx = content.indexOf(args.old_string, pos);
          if (idx === -1) break;
          count++;
          pos = idx + args.old_string.length;
        }

        if (count === 0) {
          return { isError: true, output: `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.
` };
        }
        if (count > 1) {
          return {
            isError: true,
            output:
              `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
              'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.',
          };
        }

        const newContent = replaceOnceLiteral(content, args.old_string, args.new_string);
        await this.kaos.writeText(
          safePath,
          materializeModelText(newContent, modelView.lineEndingStyle),
        );
        return { output: `Replaced 1 occurrence in ${args.path}` };
      }

      const parts = content.split(args.old_string);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        return { isError: true, output: `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.
` };
      }

      const newContent = parts.join(args.new_string);
      await this.kaos.writeText(
        safePath,
        materializeModelText(newContent, modelView.lineEndingStyle),
      );
      return { output: `Replaced ${String(replacementCount)} occurrences in ${args.path}` };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
