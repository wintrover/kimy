/**
 * SemanticGate — verification gate that runs lint/typecheck before commit.
 *
 * Executes a configurable sequence of verification steps (e.g. lint, typecheck)
 * using the agent's Kaos environment. Required steps must all pass; optional
 * steps are logged but do not block the transaction.
 */

import type { Readable } from 'node:stream';

import type { Kaos } from '@moonshot-ai/kaos';

export interface GateStep {
  readonly name: string;
  readonly command: string[];
}

export interface SemanticGateConfig {
  readonly required: GateStep[];
  readonly optional: GateStep[];
  readonly timeoutSeconds: number;
}

const DEFAULT_GATE: SemanticGateConfig = {
  required: [
    {
      name: 'lint',
      command: ['pnpm', 'exec', 'oxlint', '--type-aware', '--quiet'],
    },
  ],
  optional: [
    {
      name: 'typecheck',
      command: ['pnpm', 'exec', 'tsc', '--noEmit'],
    },
  ],
  timeoutSeconds: 120,
};

export interface StepResult {
  readonly name: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly stderr: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly results: readonly StepResult[];
  readonly failedAt?: string;
}

export class SemanticGate {
  constructor(private readonly config: SemanticGateConfig = DEFAULT_GATE) {}

  async run(kaos: Kaos): Promise<GateResult> {
    const results: StepResult[] = [];

    for (const step of this.config.required) {
      const result = await this.runStep(kaos, step);
      results.push(result);
      if (!result.passed) {
        return { passed: false, results, failedAt: step.name };
      }
    }

    for (const step of this.config.optional) {
      const result = await this.runStep(kaos, step);
      results.push(result);
    }

    return { passed: true, results };
  }

  private async runStep(kaos: Kaos, step: GateStep): Promise<StepResult> {
    try {
      const proc = await kaos.exec(...step.command);
      const timeoutMs = this.config.timeoutSeconds * 1000;

      const exitCode = await Promise.race([
        proc.wait(),
        new Promise<number>((_resolve, reject) => {
          setTimeout(() => {
            void proc.kill('SIGTERM');
            reject(new Error(`Step "${step.name}" timed out after ${this.config.timeoutSeconds}s`));
          }, timeoutMs);
        }),
      ]);

      const stderr = await collectStream(proc.stderr);

      return {
        name: step.name,
        passed: exitCode === 0,
        exitCode,
        stderr: stderr.slice(0, 2000),
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return {
        name: step.name,
        passed: false,
        exitCode: -1,
        stderr: message.slice(0, 2000),
      };
    }
  }
}

/** Collect all data from a Readable stream into a UTF-8 string. */
function collectStream(stream: Readable): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    stream.on('error', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}
