/**
 * NimCheckTool — isolated `nim check` wrapper.
 *
 * Copies the target file to a temporary directory and runs `nim check` there
 * so no writes occur in the main repository. Captures compilation errors,
 * warnings, and hints in a structured JSON format suitable for agent feedback.
 *
 * Supports `--ic:on` for incremental compilation (NIF generation).
 *
 * Dependencies injected via constructor:
 *   - `Kaos` — file-system and process-execution abstraction
 *   - `cwd` — default working directory for resolving relative paths
 *
 * Isolation strategy:
 *   - Creates a temp directory under `os.tmpdir()` via `crypto.randomUUID()`.
 *   - Copies the source file there (preserving filename for diagnostics).
 *   - Runs `nim check` with cwd set to the temp directory.
 *   - Cleans up the temp directory in a `finally` block via `rm -rf`.
 *
 * Execution goes through Kaos, never directly via node:child_process.
 */

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { createAjvValidateArgs } from '../../args-validator';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import NIM_CHECK_DESCRIPTION from './nim-check.md?raw';

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// ── Zod Schema ─────────────────────────────────────────────────────

export const NimCheckInputSchema = z.object({
  path: z
    .string()
    .min(1, 'path cannot be empty')
    .describe(
      'Path to the Nim source file to check. Relative paths resolve against the working directory.',
    ),
  ic: z
    .boolean()
    .optional()
    .describe(
      'Enable incremental compilation (--ic:on) for NIF generation. Omit or set false to skip.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_TIMEOUT_MS)
    .describe(
      `Optional timeout in milliseconds. Default ${String(DEFAULT_TIMEOUT_MS)}ms, max ${String(MAX_TIMEOUT_MS)}ms.`,
    )
    .optional(),
});

export type NimCheckInput = z.Infer<typeof NimCheckInputSchema>;

// ── Structured diagnostic types ────────────────────────────────────

export interface NimDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly severity: 'Error' | 'Warning' | 'Note';
  readonly message: string;
  readonly hint?: string | undefined;
}

export interface NimCheckReport {
  readonly file: string;
  readonly success: boolean;
  readonly diagnostics: readonly NimDiagnostic[];
  readonly exitCode: number;
}

// ── Nim stderr parser ──────────────────────────────────────────────

/**
 * Parse a single line of `nim check` stderr.
 *
 * Expected formats:
 *   `/path/file.nim(10, 5) Error: undeclared identifier 'foo'`
 *   `/path/file.nim(10, 5) Warning: unused import 'bar'`
 *   `/path/file.nim(10, 5) Hint: did you mean 'baz'?`
 *   `/path/file.nim(10, 5) Note: some note message`
 *
 * Returns `undefined` for non-diagnostic lines (e.g. nim version banners,
 * progress output, stack traces).
 */
const DIAGNOSTIC_RE =
  /^\S+\((\d+),\s*(\d+)\)\s+(Error|Warning|Hint|Note)\s*:\s*(.+?)$/;

// "Hint:" lines that follow an Error/Warning belong to that diagnostic.
const HINT_CONTINUATION_RE = /^\s+Hint:\s*(.+?)$/;

export function parseNimDiagnosticLine(
  line: string,
): Omit<NimDiagnostic, 'hint'> | undefined {
  const match = DIAGNOSTIC_RE.exec(line);
  if (match === null) return undefined;

  const lineNo = parseInt(match[1]!, 10);
  const colNo = parseInt(match[2]!, 10);
  const rawSeverity = match[3]!;
  const message = match[4]!;

  const severity: NimDiagnostic['severity'] =
    rawSeverity === 'Error'
      ? 'Error'
      : rawSeverity === 'Warning'
        ? 'Warning'
        : 'Note';

  return { line: lineNo, column: colNo, severity, message };
}

export function parseNimCheckOutput(stderr: string): readonly NimDiagnostic[] {
  const lines = stderr.split('\n');
  const diagnostics: NimDiagnostic[] = [];
  let pending: Omit<NimDiagnostic, 'hint'> | undefined;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Check for hint continuation attached to previous diagnostic.
    const hintMatch = HINT_CONTINUATION_RE.exec(trimmed);
    if (hintMatch !== null && pending !== undefined) {
      diagnostics.push({ ...pending, hint: hintMatch[1] });
      pending = undefined;
      continue;
    }

    // Flush previous diagnostic without hint.
    if (pending !== undefined) {
      diagnostics.push(pending);
      pending = undefined;
    }

    // Try to parse as a new diagnostic.
    const diag = parseNimDiagnosticLine(trimmed);
    if (diag !== undefined) {
      pending = diag;
    }
  }

  // Flush last diagnostic.
  if (pending !== undefined) {
    diagnostics.push(pending);
  }

  return diagnostics;
}

// ── Stream helpers ─────────────────────────────────────────────────

/** Collect all data from a readable stream into a string. */
function collectStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/** Close stdin so interactive commands get EOF instead of hanging. */
function closeStdin(proc: KaosProcess): void {
  try {
    proc.stdin.end();
  } catch {
    /* process already gone */
  }
}

// ── Tool implementation ────────────────────────────────────────────

export class NimCheckTool implements BuiltinTool<NimCheckInput> {
  readonly name = 'NimCheck' as const;
  readonly description: string = NIM_CHECK_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NimCheckInputSchema);
  private readonly _validateArgs = createAjvValidateArgs(this.parameters);
  validateArgs(args: unknown) {
    return this._validateArgs(args);
  }

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
  ) {}

  resolveExecution(args: NimCheckInput): ToolExecution {
    const filePath = this.resolveFilePath(args.path);

    return {
      accesses: ToolAccesses.readFile(filePath),
      description: `Checking ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'read',
        path: filePath,
        detail: `nim check${args.ic === true ? ' --ic:on' : ''}`,
      },
      approvalRule: literalRulePattern(this.name, filePath),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, filePath),
      execute: ({ signal }) => this.execution(args, filePath, signal),
    };
  }

  private resolveFilePath(path: string): string {
    if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) {
      return path;
    }
    return `${this.cwd}/${path}`;
  }

  private async execution(
    args: NimCheckInput,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before nim check started.' };
    }

    // 1. Verify source file exists.
    try {
      await this.kaos.stat(sourcePath);
    } catch {
      return { isError: true, output: `File not found: ${args.path}` };
    }

    // 2. Create an isolated temp directory.
    const tempDir = `${tmpdir()}/nim-check-${randomUUID()}`;
    try {
      await this.kaos.mkdir(tempDir, { parents: true });
    } catch (error) {
      return {
        isError: true,
        output: `Failed to create temporary directory: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let proc: KaosProcess | undefined;
    try {
      // 3. Copy source file into temp directory.
      const fileName = this.basename(sourcePath);
      const tempSource = `${tempDir}/${fileName}`;

      const sourceContent = await this.kaos.readText(sourcePath);
      await this.kaos.writeText(tempSource, sourceContent);

      // 4. Build the nim check command.
      const nimArgs = ['check'];
      if (args.ic === true) {
        nimArgs.push('--ic:on');
      }
      nimArgs.push(fileName);

      // 5. Execute nim check in the temp directory.
      const mergedEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        NO_COLOR: '1',
        TERM: 'dumb',
      };

      // Change to temp dir and run nim check.
      const fullCommand = `cd '${tempDir}' && nim ${nimArgs.map(shellQuote).join(' ')}`;

      try {
        proc = await this.kaos.execWithEnv(
          [this.kaos.osEnv.shellPath, '-c', fullCommand],
          mergedEnv,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          /ENOENT|not found|no such file/i.test(error.message)
        ) {
          return {
            isError: true,
            output:
              'Nim compiler not found on PATH. Install Nim from https://nim-lang.org/ or via choosenim/nimble.',
          };
        }
        return {
          isError: true,
          output: `Failed to execute nim check: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      closeStdin(proc);

      // 6. Collect stdout and stderr, then wait for exit.
      const stderrPromise = collectStream(proc.stderr);
      const stdoutPromise = collectStream(proc.stdout);

      // Apply timeout via AbortSignal + manual deadline.
      const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const deadline = setTimeout(() => {
        proc?.kill('SIGTERM').catch(() => {
          /* best-effort */
        });
      }, timeoutMs);

      let exitCode: number;
      try {
        exitCode = await proc.wait();
      } catch {
        exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }

      const stderr = await stderrPromise;
      const stdout = await stdoutPromise;

      await Promise.resolve(proc.dispose()).catch(() => {
        /* best-effort */
      });

      // 7. Parse diagnostics.
      const diagnostics = parseNimCheckOutput(stderr);
      const hasErrors = diagnostics.some((d) => d.severity === 'Error');

      const report: NimCheckReport = {
        file: args.path,
        success: exitCode === 0 && !hasErrors,
        diagnostics,
        exitCode,
      };

      // 8. Format output.
      return this.formatReport(report, stdout);
    } finally {
      // 9. Clean up temp directory (best-effort via shell).
      try {
        const cleanup = await this.kaos.execWithEnv(
          [this.kaos.osEnv.shellPath, '-c', `rm -rf '${tempDir}'`],
        );
        await cleanup.wait().catch(() => {
          /* best-effort */
        });
        await Promise.resolve(cleanup.dispose()).catch(() => {
          /* best-effort */
        });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private formatReport(
    report: NimCheckReport,
    stdout: string,
  ): ExecutableToolResult {
    const { success, diagnostics, file, exitCode } = report;

    if (diagnostics.length === 0 && success) {
      const result: NimCheckReport & { message: string } = {
        ...report,
        message: `${file} checks clean.`,
      };
      return { output: JSON.stringify(result, null, 2) };
    }

    // Sort: errors first, then warnings, then notes.
    const severityOrder: Record<string, number> = { Error: 0, Warning: 1, Note: 2 };
    const sorted = [...diagnostics].sort(
      (a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
    );

    const reportWithSorted = { ...report, diagnostics: sorted };
    const json = JSON.stringify(reportWithSorted, null, 2);

    if (success && sorted.length > 0) {
      // Warnings only — return success with diagnostics.
      return { output: json };
    }

    const errorCount = diagnostics.filter((d) => d.severity === 'Error').length;
    const warningCount = diagnostics.filter((d) => d.severity === 'Warning').length;

    return {
      isError: !success,
      output: json,
      message: stdout.length > 0
        ? `${file}: ${String(errorCount)} error(s), ${String(warningCount)} warning(s).\n${stdout}`
        : `${file} has ${String(errorCount)} error(s), ${String(warningCount)} warning(s).`,
    };
  }

  private basename(filePath: string): string {
    const normalized = filePath.replaceAll('\\', '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
