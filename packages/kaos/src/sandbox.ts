import type { Environment } from './environment';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { ContentVector, SnapshotOptions, StatResult } from './types';

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

/**
 * Configuration for Bubblewrap-based process isolation.
 *
 * Uses Linux user namespaces + mount namespaces to sandbox process execution.
 * The key feature is `--unshare-net` which removes the network interface,
 * causing any network call to fail immediately (ECONNREFUSED in ~0ms) instead
 * of hanging on a timeout. This deterministically eliminates the state space
 * where network-dependent hooks (e.g. ci-pipeline-health-gate) can hang.
 */
export interface BubblewrapIsolationConfig {
  enabled: boolean;
  /** $HOME path for dynamic bind-mount (nvm node, .gitconfig, project files). */
  homeDir: string;
  /** When false, adds --unshare-net to block all network access. */
  networkAccess: boolean;
  /** When true (default), adds --die-with-parent for best-effort cleanup. */
  dieWithParent: boolean;
  /** When true, skip --tmpfs /tmp so host /tmp is visible inside the sandbox. Needed when HermeticKaos projection is active. */
  inheritTmp?: boolean;
  /** Host absolute path to workspace root. Bind-mounted to /workspace inside sandbox. */
  workspaceRoot?: string;
  /** Relative path from workspaceRoot to the agent's cwd. Used with --chdir /workspace/<rel>. */
  workspaceRelCwd?: string;
  /** Environment variables to inject into the sandbox (--setenv) */
  extraEnv?: Record<string, string>;
  /** Whether to clear host environment (--clearenv) */
  clearEnv?: boolean;
}

// ── Bubblewrap mount helpers ──────────────────────────────────────

interface ResolvedSymlink {
  readonly kind: 'symlink';
  readonly target: string;
}

interface ResolvedDirectory {
  readonly kind: 'directory';
}

type PathResolution = ResolvedSymlink | ResolvedDirectory;

/**
 * Probe a path to determine if it's a symlink or a real directory.
 * Used for Merged-Usr compatibility: on merged-usr systems `/bin` is a
 * symlink to `usr/bin`, while on traditional layouts it's a real directory.
 */
async function probePath(path: string): Promise<PathResolution> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(path);
      return { kind: 'symlink', target };
    }
    return { kind: 'directory' };
  } catch {
    // Path doesn't exist — treat as directory (bwrap will handle the error)
    return { kind: 'directory' };
  }
}

/**
 * Detect which of /bin, /lib, /lib64, /sbin are symlinks (Merged-Usr)
 * vs real directories (traditional layout). The result is cached after
 * the first call since the filesystem layout doesn't change at runtime.
 */
let _cachedMountLayout: BubblewrapMountLayout | undefined;

export interface BubblewrapMountLayout {
  readonly bin: PathResolution;
  readonly lib: PathResolution;
  readonly lib64: PathResolution;
  readonly sbin: PathResolution;
}

export async function detectBubblewrapMountLayout(): Promise<BubblewrapMountLayout> {
  if (_cachedMountLayout !== undefined) return _cachedMountLayout;
  const [bin, lib, lib64, sbin] = await Promise.all([
    probePath('/bin'),
    probePath('/lib'),
    probePath('/lib64'),
    probePath('/sbin'),
  ]);
  _cachedMountLayout = { bin, lib, lib64, sbin };
  return _cachedMountLayout;
}

/**
 * Walk up from `startDir` to find the nearest ancestor containing
 * `.git/` or `pnpm-workspace.yaml` (workspace root marker).
 * Returns the absolute host path, or `undefined` if not found.
 */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  let prev = '';
  while (dir !== prev) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    prev = dir;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Check if bubblewrap (`bwrap`) is available on this system.
 * Caches the result after first call.
 */
let _bwrapAvailable: boolean | undefined;

export async function isBubblewrapAvailable(): Promise<boolean> {
  if (_bwrapAvailable !== undefined) return _bwrapAvailable;
  try {
    const { execFile } = await import('node:child_process');
    _bwrapAvailable = await new Promise<boolean>((resolve) => {
      execFile('bwrap', ['--version'], { timeout: 3000 }, (error) => {
        resolve(error === null);
      });
    });
  } catch {
    _bwrapAvailable = false;
  }
  return _bwrapAvailable;
}

/**
 * Pre-check toolchain versions inside the sandbox against project requirements.
 * Logs warnings only — does not block execution.
 */
async function precheckToolchainVersions(
  config: BubblewrapIsolationConfig,
  log?: { warn: (msg: string) => void }
): Promise<void> {
  if (!config.workspaceRoot) return;

  // Check if project has a flake.nix (indicating Nix toolchain requirements)
  const flakePath = join(config.workspaceRoot, 'flake.nix');
  if (!existsSync(flakePath)) return;

  const tools = ['node', 'git', 'nim', 'z3'];
  for (const tool of tools) {
    try {
      const { execFile: execFileCb } = await import('node:child_process');
      const version = await new Promise<string | undefined>((resolve) => {
        execFileCb(tool, ['--version'], { timeout: 5_000 }, (err, stdout) => {
          resolve(err ? undefined : stdout.trim().split('\n')[0]);
        });
      });
      if (version) {
        log?.warn?.(`[sandbox] ${tool} version: ${version}`);
      }
    } catch {
      // Tool not available — not an error
    }
  }
}

// ── Nix devShell environment detection ────────────────────────────

/** Process-lifetime cache keyed by `${workspaceRoot}:${flake.nix mtimeMs}` */
const nixEnvCache = new Map<string, Record<string, string> | undefined>();

async function detectNixDevShellEnv(
  workspaceRoot?: string
): Promise<Record<string, string> | undefined> {
  let cacheKey = workspaceRoot ?? '__default__';
  if (workspaceRoot) {
    const flakePath = join(workspaceRoot, 'flake.nix');
    if (existsSync(flakePath)) {
      const { statSync } = await import('node:fs');
      const stat = statSync(flakePath);
      cacheKey = `${workspaceRoot}:${stat.mtimeMs}`;
    }
  }
  if (nixEnvCache.has(cacheKey)) return nixEnvCache.get(cacheKey);

  const result = await detectNixDevShellEnvUncached(workspaceRoot);
  nixEnvCache.set(cacheKey, result);
  return result;
}

async function detectNixDevShellEnvUncached(
  workspaceRoot?: string
): Promise<Record<string, string> | undefined> {
  if (!existsSync('/nix/store')) return undefined;
  const hasFlake = workspaceRoot && existsSync(join(workspaceRoot, 'flake.nix'));
  const inNixShell = !!process.env['IN_NIX_SHELL'];
  if (!hasFlake && !inNixShell) return undefined;

  const target = workspaceRoot ?? process.cwd();
  try {
    const { execFile: execFileCb } = await import('node:child_process');
    const stdout = await new Promise<string>((resolve, reject) => {
      execFileCb('nix', ['print-dev-env', '--json', target], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }, (err, out) => err ? reject(err) : resolve(out));
    });
    const parsed = JSON.parse(stdout);
    const env: Record<string, string> = {};
    if (parsed.variables) {
      for (const [key, val] of Object.entries(parsed.variables)) {
        if (val && typeof val === 'object' && 'type' in val && 'value' in val) {
          const entry = val as { type: string; value: unknown };
          if (entry.type === 'array' || Array.isArray(entry.value)) continue;
          env[key] = String(entry.value);
        }
      }
    }
    return env;
  } catch {
    return undefined;
  }
}

/**
 * Build the bwrap argument list for sandboxed process execution.
 *
 * Mount strategy:
 * 1. --ro-bind /usr /usr: system binaries (git, python3, etc.)
 * 2. Symlink or bind /bin, /lib, /lib64, /sbin based on Merged-Usr detection
 * 3. --ro-bind /etc /etc: /etc/hosts, /etc/alternatives, etc.
 * 4. --bind $HOME $HOME: nvm node, .gitconfig, project files
 * 5. --tmpfs /tmp: isolated temp directory
 * 6. --unshare-net: remove network interface (0ms ECONNREFUSED)
 * 7. --die-with-parent: SIGKILL on parent death (best-effort)
 * 8. --new-session: prevent TTY ioctl attacks
 */
export async function buildBubblewrapArgs(config: BubblewrapIsolationConfig): Promise<string[]> {
  const layout = await detectBubblewrapMountLayout();
  const args: string[] = ['bwrap'];

  // Core filesystem: /usr is always a real directory
  args.push('--ro-bind', '/usr', '/usr');

  // Merged-Usr compatibility: symlink vs bind for /bin, /lib, /lib64, /sbin
  for (const [name, resolution] of Object.entries({
    bin: layout.bin,
    lib: layout.lib,
    lib64: layout.lib64,
    sbin: layout.sbin,
  }) as Array<[string, PathResolution]>) {
    if (resolution.kind === 'symlink') {
      args.push('--symlink', resolution.target, `/${name}`);
    } else {
      args.push('--ro-bind', `/${name}`, `/${name}`);
    }
  }

  // Nix Store auto-detection: host PATH contains /nix/store paths → mount it
  const hostPath = process.env['PATH'] ?? '';
  const hasNixStorePaths = hostPath.split(':').some(p => p.startsWith('/nix/store/'));
  if (hasNixStorePaths) {
    args.push('--ro-bind', '/nix/store', '/nix/store');
  }

  // /etc for hosts, alternatives, resolv.conf
  args.push('--ro-bind', '/etc', '/etc');

  // Home directory for nvm node, .gitconfig, project files
  args.push('--bind', config.homeDir, config.homeDir);

  // Canonical workspace mapping: host workspace root → /workspace
  const chdirTarget = config.workspaceRelCwd
    ? `/workspace/${config.workspaceRelCwd}`
    : '/workspace';
  if (config.workspaceRoot) {
    args.push('--bind', config.workspaceRoot, '/workspace');
    args.push('--chdir', chdirTarget);

    // Git safe.directory: sandbox remaps host paths, so mark all
    // sandbox-visible directories as safe. '*' also covers submodules.
    args.push('--setenv', 'GIT_CONFIG_COUNT', '1');
    args.push('--setenv', 'GIT_CONFIG_KEY_0', 'safe.directory');
    args.push('--setenv', 'GIT_CONFIG_VALUE_0', '*');

    // PWD: --chdir changes CWD but doesn't update $PWD env var.
    // Some tools (shell scripts, Makefiles) read $PWD directly.
    args.push('--setenv', 'PWD', chdirTarget);
  }

  // Hermetic Nix environment injection
  const nixEnv = await detectNixDevShellEnv(config.workspaceRoot);
  if (nixEnv) {
    args.push('--clearenv');
    for (const [key, val] of Object.entries(nixEnv)) {
      if (typeof val !== 'string') continue;
      args.push('--setenv', key, val);
    }
    args.push('--setenv', 'HOME', config.homeDir);
    args.push('--setenv', 'TERM', process.env['TERM'] ?? 'xterm-256color');
    args.push('--setenv', 'GIT_CONFIG_COUNT', '1');
    args.push('--setenv', 'GIT_CONFIG_KEY_0', 'safe.directory');
    args.push('--setenv', 'GIT_CONFIG_VALUE_0', '*');
    args.push('--setenv', 'PWD', chdirTarget);
  }

  // Manual extra environment variables
  if (config.extraEnv) {
    for (const [key, val] of Object.entries(config.extraEnv)) {
      args.push('--setenv', key, val);
    }
  }
  if (config.clearEnv && !nixEnv) {
    // Manual clear-env requested but no nix env detected
    args.push('--clearenv');
    args.push('--setenv', 'HOME', config.homeDir);
    args.push('--setenv', 'TERM', process.env['TERM'] ?? 'xterm-256color');
  }

  // Share read-only user config files from real $HOME
  const realHome = process.env['HOME'] ?? homedir();
  const sharedConfigFiles = ['.gitconfig', '.npmrc'];
  for (const file of sharedConfigFiles) {
    const hostPath = join(realHome, file);
    const sandboxPath = join(config.homeDir, file);
    if (existsSync(hostPath)) {
      args.push('--ro-bind', hostPath, sandboxPath);
    }
  }

  // Dynamically resolve Node.js runtime directory via `which node`
  const { execFile: execFileCb } = await import('node:child_process');
  const nodePath = await new Promise<string | undefined>((resolve) => {
    execFileCb('which', ['node'], (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
  if (nodePath) {
    const { realpath } = await import('node:fs/promises');
    // Resolve symlinks to get the canonical path (handles nvm, fnm, volta, mise)
    const realNodeBin = await realpath(nodePath);
    const nodeBinDir = dirname(realNodeBin);
    // Bind-mount the directory containing the node binary
    args.push('--ro-bind', nodeBinDir, nodeBinDir);
  }

  // Isolated temp and device filesystem
  args.push('--proc', '/proc', '--dev', '/dev');
  if (!config.inheritTmp) {
    args.push('--tmpfs', '/tmp');
  }

  // Session isolation
  args.push('--new-session');

  // Network isolation: the core fix for hang elimination
  if (!config.networkAccess) {
    args.push('--unshare-net');
  }

  // Best-effort parent death cleanup
  if (config.dieWithParent) {
    args.push('--die-with-parent');
  }

  return args;
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
    this._bubblewrapConfig = bubblewrapConfig;

    // Fire-and-forget toolchain version pre-check (warning only)
    if (this._bubblewrapConfig?.enabled && this._bubblewrapConfig.workspaceRoot) {
      precheckToolchainVersions(this._bubblewrapConfig, console).catch(() => {
        // Silent — pre-check failures should never block execution
      });
    }
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

  snapshot(root: string, options?: SnapshotOptions): Promise<ContentVector> {
    return this._inner.snapshot(root, options);
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
