import type { Environment } from './environment';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

// ── Error classes ─────────────────────────────────────────────────

export class SandboxViolationError extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(message);
    this.name = 'SandboxViolationError';
    this.command = command;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// ── Configuration types ───────────────────────────────────────────

export interface CommandFilterConfig {
  /** Regex patterns that block dangerous commands outright. */
  blockedPatterns: RegExp[];
  /** Regex patterns that require human approval before execution. */
  requireApprovalPatterns: RegExp[];
  /** When set, only these exact command prefixes are permitted. */
  allowedCommands?: string[];
}

export interface ContainerIsolationConfig {
  enabled: boolean;
  runtime: 'docker' | 'podman';
  image: string;
  worktreeMountPoint: string;
  networkMode: 'none' | 'host' | 'bridge';
  memoryLimit?: string;
  cpuLimit?: string;
}

export interface NamespaceIsolationConfig {
  enabled: boolean;
  mountNamespace: boolean;
  pidNamespace: boolean;
}

// ── CommandFilter ─────────────────────────────────────────────────

export interface CommandFilter {
  blockedPatterns: RegExp[];
  requireApprovalPatterns: RegExp[];
  allowedCommands?: string[];
  validate(command: string): { allowed: boolean; reason?: string };
}

function buildDefaultBlockedPatterns(): RegExp[] {
  return [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive.*--force|--force.*--recursive)\s+\/[^;\s]*/i,
    /\brm\s+-rf?\s+\/\s*$/i,
    /\bmkfs\b/i,
    /\bdd\s+.*of=\/dev\//i,
    /\b:\(\)\s*\{.*\|\:\s*&\s*\}/i,
    /\bcurl\b.*\|\s*bash/i,
    /\bwget\b.*\|\s*bash/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
  ];
}

function buildDefaultApprovalPatterns(): RegExp[] {
  return [
    /\bgit\s+push\b.*--force/i,
    /\bgit\s+push\b.*-f\b/i,
    /\bgit\s+reset\s+--hard/i,
    /\bgit\s+clean\s+-fd/i,
  ];
}

/**
 * Build a {@link CommandFilter} from partial config, filling in safe
 * defaults for missing fields.
 */
export function createCommandFilter(config?: Partial<CommandFilterConfig>): CommandFilter {
  const blockedPatterns = config?.blockedPatterns ?? buildDefaultBlockedPatterns();
  const requireApprovalPatterns = config?.requireApprovalPatterns ?? buildDefaultApprovalPatterns();
  const allowedCommands = config?.allowedCommands;

  return {
    blockedPatterns,
    requireApprovalPatterns,
    allowedCommands,
    validate(command: string): { allowed: boolean; reason?: string } {
      for (const pattern of blockedPatterns) {
        if (pattern.test(command)) {
          return { allowed: false, reason: `Command blocked by pattern: ${pattern.source}` };
        }
      }
      if (allowedCommands !== undefined && allowedCommands.length > 0) {
        const firstToken = command.trim().split(/\s+/)[0] ?? '';
        if (!allowedCommands.includes(firstToken)) {
          return {
            allowed: false,
            reason: `Command "${firstToken}" is not in the allow list`,
          };
        }
      }
      return { allowed: true };
    },
  };
}

// ── SandboxKaos ───────────────────────────────────────────────────

/**
 * Wraps any {@link Kaos} with process isolation layers:
 * command filtering, containerisation, and namespace sandboxing.
 */
export class SandboxKaos implements Kaos {
  private readonly _inner: Kaos;
  private readonly _filter: CommandFilter;
  private readonly _containerConfig?: ContainerIsolationConfig;
  private readonly _namespaceConfig?: NamespaceIsolationConfig;

  constructor(
    inner: Kaos,
    filterConfig?: Partial<CommandFilterConfig>,
    namespaceConfig?: NamespaceIsolationConfig,
    containerConfig?: ContainerIsolationConfig,
  ) {
    this._inner = inner;
    this._filter = createCommandFilter(filterConfig);
    this._containerConfig = containerConfig;
    this._namespaceConfig = namespaceConfig;
  }

  // ── Read-only pass-through ───────────────────────────────────────

  get name(): string {
    return this._inner.name;
  }

  get osEnv(): Environment {
    return this._inner.osEnv;
  }

  pathClass(): 'posix' | 'win32' {
    return this._inner.pathClass();
  }

  normpath(path: string): string {
    return this._inner.normpath(path);
  }

  gethome(): string {
    return this._inner.gethome();
  }

  getcwd(): string {
    return this._inner.getcwd();
  }

  chdir(path: string): Promise<void> {
    return this._inner.chdir(path);
  }

  withCwd(cwd: string): SandboxKaos {
    return new SandboxKaos(
      this._inner.withCwd(cwd),
      {
        blockedPatterns: this._filter.blockedPatterns,
        requireApprovalPatterns: this._filter.requireApprovalPatterns,
        allowedCommands: this._filter.allowedCommands,
      },
      this._namespaceConfig,
      this._containerConfig,
    );
  }

  withEnv(env: Record<string, string>): SandboxKaos {
    return new SandboxKaos(
      this._inner.withEnv(env),
      {
        blockedPatterns: this._filter.blockedPatterns,
        requireApprovalPatterns: this._filter.requireApprovalPatterns,
        allowedCommands: this._filter.allowedCommands,
      },
      this._namespaceConfig,
      this._containerConfig,
    );
  }

  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    return this._inner.stat(path, options);
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    yield* this._inner.iterdir(path);
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    yield* this._inner.glob(path, pattern, options);
  }

  readBytes(path: string, n?: number): Promise<Buffer> {
    return this._inner.readBytes(path, n);
  }

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    return this._inner.readText(path, options);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    yield* this._inner.readLines(path, options);
  }

  writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    return this._inner.writeText(path, data, options);
  }

  writeBytes(path: string, data: Buffer): Promise<number> {
    return this._inner.writeBytes(path, data);
  }

  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    return this._inner.mkdir(path, options);
  }

  // ── Process execution ────────────────────────────────────────────

  async exec(...args: string[]): Promise<KaosProcess> {
    const command = args.join(' ');
    const { allowed, reason } = this._filter.validate(command);
    if (!allowed) {
      throw new SandboxViolationError(reason ?? 'Command blocked by sandbox filter', command);
    }

    if (this._containerConfig?.enabled) {
      return this._execInContainer(args);
    }
    if (this._namespaceConfig?.enabled) {
      return this._execInNamespace(args);
    }
    return this._inner.exec(...args);
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const command = args.join(' ');
    const { allowed, reason } = this._filter.validate(command);
    if (!allowed) {
      throw new SandboxViolationError(reason ?? 'Command blocked by sandbox filter', command);
    }

    if (this._containerConfig?.enabled) {
      return this._execInContainer(args, env);
    }
    if (this._namespaceConfig?.enabled) {
      return this._execInNamespace(args, env);
    }
    return this._inner.execWithEnv(args, env);
  }

  /**
   * Execute a command with verification-level isolation: network disabled
   * and a 30-second wall-clock timeout via `AbortController`.
   */
  async execForVerification(
    ...args: string[]
  ): Promise<KaosProcess> {
    const command = args.join(' ');
    const { allowed, reason } = this._filter.validate(command);
    if (!allowed) {
      throw new SandboxViolationError(reason ?? 'Command blocked by sandbox filter', command);
    }

    const fullArgs = this._containerConfig?.enabled
      ? this._buildContainerArgs(args, { networkMode: 'none' })
      : args;

    const proc = await this._inner.exec(...fullArgs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    // Attach an abort listener that kills the process on timeout.
    controller.signal.addEventListener('abort', () => {
      proc.kill('SIGKILL').catch(() => {
        /* best effort */
      });
    });

    // Clear the timer when the process exits naturally.
    proc.wait().finally(() => clearTimeout(timer));

    return proc;
  }

  // ── Command filter access ────────────────────────────────────────

  /** Expose the underlying command filter for external inspection. */
  get commandFilter(): CommandFilter {
    return this._filter;
  }

  // ── Container execution ──────────────────────────────────────────

  private async _execInContainer(
    args: string[],
    env?: Record<string, string>,
  ): Promise<KaosProcess> {
    const containerArgs = this._buildContainerArgs(args);
    if (env !== undefined) {
      return this._inner.execWithEnv(containerArgs, env);
    }
    return this._inner.exec(...containerArgs);
  }

  private _buildContainerArgs(
    args: string[],
    overrides?: { networkMode?: 'none' | 'host' | 'bridge' },
  ): string[] {
    const cfg = this._containerConfig;
    if (!cfg) return args;

    const uid = process.getuid?.() ?? process.geteuid?.() ?? 1000;
    const gid = process.getgid?.() ?? process.getegid?.() ?? 1000;
    const networkMode = overrides?.networkMode ?? cfg.networkMode;

    const containerArgs: string[] = [
      'run',
      '--rm',
      `-u`,
      `${String(uid)}:${String(gid)}`,
      `--network`,
      networkMode,
      '-v',
      `${this._inner.getcwd()}:${cfg.worktreeMountPoint}`,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid',
    ];

    if (cfg.memoryLimit !== undefined) {
      containerArgs.push('--memory', cfg.memoryLimit);
    }
    if (cfg.cpuLimit !== undefined) {
      containerArgs.push('--cpus', cfg.cpuLimit);
    }

    containerArgs.push(cfg.image, ...args);
    return containerArgs;
  }

  // ── Namespace execution ──────────────────────────────────────────

  private async _execInNamespace(
    args: string[],
    env?: Record<string, string>,
  ): Promise<KaosProcess> {
    const cfg = this._namespaceConfig;
    if (!cfg) {
      return env !== undefined
        ? this._inner.execWithEnv(args, env)
        : this._inner.exec(...args);
    }

    const unshareArgs: string[] = [];
    if (cfg.mountNamespace) unshareArgs.push('--mount');
    if (cfg.pidNamespace) unshareArgs.push('--pid');

    if (unshareArgs.length === 0) {
      return env !== undefined
        ? this._inner.execWithEnv(args, env)
        : this._inner.exec(...args);
    }

    const fullArgs = ['unshare', ...unshareArgs, '--', ...args];
    if (env !== undefined) {
      return this._inner.execWithEnv(fullArgs, env);
    }
    return this._inner.exec(...fullArgs);
  }
}
