import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildBubblewrapArgs,
  findWorkspaceRoot,
  isBubblewrapAvailable,
  SandboxKaos,
  type BubblewrapIsolationConfig,
} from '#/sandbox';
import { LocalKaos } from '#/local';

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Run a command inside a bubblewrap sandbox built from the given config.
 * Returns { stdout, stderr, exitCode }.
 */
async function runInSandbox(
  config: BubblewrapIsolationConfig,
  command: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = await buildBubblewrapArgs(config);
  const fullArgs = [...args, '--', ...command];

  return new Promise((resolve, reject) => {
    execFileCb(
      fullArgs[0]!,
      fullArgs.slice(1),
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: error ? (typeof error === 'object' && error !== null && 'status' in error ? (error as { status: number }).status : 1) : 0,
        });
      },
    );
  });
}

// ── Canonical Workspace Mapping: Integration Tests ─────────────────
//
// These tests run actual `bwrap` processes on the host. They verify that the
// argument list produced by `buildBubblewrapArgs` results in a functional
// sandbox where:
//   - The workspace root is available at /workspace
//   - The agent cwd is correctly set inside /workspace
//   - Cross-package references work (monorepo siblings, root config files)
//   - Git commands work without "dubious ownership" errors
//   - Shared config files (e.g. .gitconfig) are read-only
//
// The describe block is guarded: every test bails out early when bwrap is
// unavailable on the host, so the suite is a no-op in those environments.

describe('Bubblewrap sandbox integration: Canonical Workspace Mapping', () => {
  const tmpDirs: string[] = [];
  let bwrapReady = false;

  beforeEach(async () => {
    bwrapReady = await isBubblewrapAvailable();
  });

  /**
   * Create a temp directory outside /tmp for sandbox bind mounts.
   * Bwrap's `--tmpfs /tmp` mounts a fresh empty tmpfs over /tmp, which
   * destroys any host /tmp-based bind mounts placed beneath it.
   */
  function makeBwrapSafeTmpDir(): string {
    const base = process.env['HOME'] ?? homedir();
    const dir = mkdtempSync(join(base, '.bwrap-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Scenario 1: Basic workspace access ───────────────────────────

  describe('scenario 1: basic workspace access', () => {
    it('should set subagent cwd to /workspace path', async () => {
      if (!bwrapReady) return;

      const workspaceRoot = makeBwrapSafeTmpDir();
      // Simulate a monorepo sub-directory as the agent's working dir
      const relCwd = 'packages/agent-core';
      mkdirSync(join(workspaceRoot, relCwd), { recursive: true });

      const homeDir = makeBwrapSafeTmpDir();

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: relCwd,
      };

      const result = await runInSandbox(config, ['pwd']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`/workspace/${relCwd}`);
    });

    it('should default to /workspace when workspaceRelCwd is empty', async () => {
      if (!bwrapReady) return;

      const workspaceRoot = makeBwrapSafeTmpDir();
      const homeDir = makeBwrapSafeTmpDir();

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: '',
      };

      const result = await runInSandbox(config, ['pwd']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('/workspace');
    });

    it('should bind-mount workspaceRoot contents into /workspace', async () => {
      if (!bwrapReady) return;

      const workspaceRoot = makeBwrapSafeTmpDir();
      writeFileSync(join(workspaceRoot, 'marker.txt'), 'hello from host');
      mkdirSync(join(workspaceRoot, 'src', 'lib'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'src', 'lib', 'index.ts'), 'export const x = 1;');

      const homeDir = makeBwrapSafeTmpDir();

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: 'src/lib',
      };

      const catResult = await runInSandbox(config, ['cat', '/workspace/marker.txt']);
      expect(catResult.exitCode).toBe(0);
      expect(catResult.stdout).toBe('hello from host');

      const catTsResult = await runInSandbox(config, ['cat', '/workspace/src/lib/index.ts']);
      expect(catTsResult.exitCode).toBe(0);
      expect(catTsResult.stdout).toBe('export const x = 1;');
    });
  });

  // ── Scenario 2: Cross-package build reference ────────────────────

  describe('scenario 2: cross-package build reference (monorepo)', () => {
    it('should allow subagent to access files from parent workspace directories', async () => {
      if (!bwrapReady) return;

      // Build a realistic monorepo skeleton inside a temp dir
      const workspaceRoot = makeBwrapSafeTmpDir();
      writeFileSync(
        join(workspaceRoot, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n',
      );
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        '{"name":"example-monorepo","private":true}\n',
      );
      mkdirSync(join(workspaceRoot, 'node_modules', '.package-lock'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'node_modules', '.package-lock', 'ok'), '');

      const pkgCore = join(workspaceRoot, 'packages', 'agent-core');
      mkdirSync(pkgCore, { recursive: true });
      writeFileSync(join(pkgCore, 'tsconfig.json'), '{"extends":"../../tsconfig.json"}\n');

      // Sibling package
      const pkgSibling = join(workspaceRoot, 'packages', 'kaos');
      mkdirSync(pkgSibling, { recursive: true });
      writeFileSync(join(pkgSibling, 'index.ts'), '// sibling package entry\n');

      const homeDir = makeBwrapSafeTmpDir();
      const relCwd = relative(workspaceRoot, pkgCore);

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: relCwd,
      };

      // 1. Read workspace root marker (../../ from agent cwd inside sandbox)
      const pnpmResult = await runInSandbox(config, ['cat', '/workspace/pnpm-workspace.yaml']);
      expect(pnpmResult.exitCode).toBe(0);
      expect(pnpmResult.stdout).toContain('packages/*');

      // 2. Access root node_modules
      const nodeModulesResult = await runInSandbox(config, ['ls', '/workspace/node_modules/.package-lock/ok']);
      expect(nodeModulesResult.exitCode).toBe(0);

      // 3. Access sibling package
      const siblingResult = await runInSandbox(config, ['cat', '/workspace/packages/kaos/index.ts']);
      expect(siblingResult.exitCode).toBe(0);
      expect(siblingResult.stdout).toContain('sibling package entry');

      // 4. Read own package's config that extends root
      const tsconfigResult = await runInSandbox(config, ['cat', '/workspace/packages/agent-core/tsconfig.json']);
      expect(tsconfigResult.exitCode).toBe(0);
      expect(tsconfigResult.stdout).toContain('../../tsconfig.json');
    });
  });

  // ── Scenario 3: Git operations ───────────────────────────────────

  describe('scenario 3: git operations', () => {
    it('should allow subagent to run git commands without dubious ownership', async () => {
      if (!bwrapReady) return;

      // We need a real git repo for git to cooperate
      const workspaceRoot = makeBwrapSafeTmpDir();
      const homeDir = makeBwrapSafeTmpDir();

      // Initialise a git repo on the host
      await new Promise<void>((resolve, reject) => {
        execFileCb('git', ['init', workspaceRoot], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      // Configure git user so `git log` works even without global config
      await new Promise<void>((resolve, reject) => {
        execFileCb(
          'git',
          ['-C', workspaceRoot, 'config', 'user.email', 'test@example.test'],
          { timeout: 5000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      await new Promise<void>((resolve, reject) => {
        execFileCb(
          'git',
          ['-C', workspaceRoot, 'config', 'user.name', 'Test User'],
          { timeout: 5000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      // Create an initial commit so git log has something to show
      writeFileSync(join(workspaceRoot, 'README.md'), 'init\n');
      await new Promise<void>((resolve, reject) => {
        execFileCb(
          'git',
          ['-C', workspaceRoot, 'add', '.'],
          { timeout: 5000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      await new Promise<void>((resolve, reject) => {
        execFileCb(
          'git',
          ['-C', workspaceRoot, 'commit', '-m', 'init'],
          { timeout: 5000, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' } },
          (err) => (err ? reject(err) : resolve()),
        );
      });

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: '',
      };

      // git status should succeed (no dubious ownership error)
      const statusResult = await runInSandbox(config, ['git', 'status', '--porcelain']);
      expect(statusResult.exitCode).toBe(0);

      // git log should succeed
      const logResult = await runInSandbox(config, ['git', 'log', '--oneline', '-1']);
      expect(logResult.exitCode).toBe(0);
      expect(logResult.stdout).toContain('init');

      // git diff should succeed (even if empty)
      const diffResult = await runInSandbox(config, ['git', 'diff']);
      expect(diffResult.exitCode).toBe(0);
    });
  });

  // ── Scenario 4: Read-only config verification ────────────────────

  describe('scenario 4: read-only config files', () => {
    it('should expose .gitconfig as read-only in sandbox', async () => {
      if (!bwrapReady) return;

      const workspaceRoot = makeBwrapSafeTmpDir();
      const homeDir = makeBwrapSafeTmpDir();

      // The sandbox code does `--ro-bind $realHome/.gitconfig $homeDir/.gitconfig`
      // only when the file exists on the host. We need a real .gitconfig (or we
      // create a temporary one and point HOME there via the homeDir config).
      //
      // Since buildBubblewrapArgs reads `process.env.HOME ?? homedir()` for the
      // real host .gitconfig, we can only test read-only when one exists.
      const realHome = process.env['HOME'] ?? homedir();
      const gitconfigExists = existsSync(join(realHome, '.gitconfig'));

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: '',
      };

      if (gitconfigExists) {
        // cat should succeed — file is bind-mounted read-only
        const catResult = await runInSandbox(config, ['cat', join(homeDir, '.gitconfig')]);
        expect(catResult.exitCode).toBe(0);
        // The content should match the host's .gitconfig
        const hostContent = readFileSync(join(realHome, '.gitconfig'), 'utf8');
        expect(catResult.stdout).toBe(hostContent);

        // Writing to .gitconfig should fail (read-only mount)
        const writeResult = await runInSandbox(config, [
          'sh',
          '-c',
          `echo "injected" >> ${join(homeDir, '.gitconfig')}`,
        ]);
        expect(writeResult.exitCode).not.toBe(0);
      }
    });

    it('should expose .npmrc as read-only when it exists on host', async () => {
      if (!bwrapReady) return;

      const workspaceRoot = makeBwrapSafeTmpDir();
      const homeDir = makeBwrapSafeTmpDir();

      const realHome = process.env['HOME'] ?? homedir();
      const npmrcExists = existsSync(join(realHome, '.npmrc'));

      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: '',
      };

      if (npmrcExists) {
        const catResult = await runInSandbox(config, ['cat', join(homeDir, '.npmrc')]);
        expect(catResult.exitCode).toBe(0);

        const hostContent = readFileSync(join(realHome, '.npmrc'), 'utf8');
        expect(catResult.stdout).toBe(hostContent);

        // Write attempt should fail
        const writeResult = await runInSandbox(config, [
          'sh',
          '-c',
          `echo "injected" >> ${join(homeDir, '.npmrc')}`,
        ]);
        expect(writeResult.exitCode).not.toBe(0);
      }
    });
  });

  // ── Additional arg-level verification ────────────────────────────

  describe('buildBubblewrapArgs: canonical workspace mapping details', () => {
    it('should produce --bind host-root /workspace and --chdir /workspace/rel', async () => {
      const args = await buildBubblewrapArgs({
        enabled: true,
        homeDir: '/tmp/h',
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot: '/home/dev/project',
        workspaceRelCwd: 'packages/core/src',
      });

      // Verify the canonical workspace bind
      let workspaceBindFound = false;
      for (let i = 0; i < args.length; i++) {
        if (
          args[i] === '--bind' &&
          args[i + 1] === '/home/dev/project' &&
          args[i + 2] === '/workspace'
        ) {
          workspaceBindFound = true;
          break;
        }
      }
      expect(workspaceBindFound).toBe(true);

      // Verify --chdir points into /workspace
      const chdirIdx = args.indexOf('--chdir');
      expect(chdirIdx).toBeGreaterThan(-1);
      expect(args[chdirIdx + 1]).toBe('/workspace/packages/core/src');

      // Verify PWD env is set to match --chdir
      const setenvEntries: [string, string][] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--setenv' && i + 2 < args.length) {
          setenvEntries.push([args[i + 1]!, args[i + 2]!]);
        }
      }
      expect(setenvEntries).toContainEqual(['PWD', '/workspace/packages/core/src']);
    });

    it('should set GIT_CONFIG_COUNT for safe.directory when workspace is mapped', async () => {
      const args = await buildBubblewrapArgs({
        enabled: true,
        homeDir: '/tmp/h',
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot: '/home/dev/project',
        workspaceRelCwd: '',
      });

      const setenvEntries: [string, string][] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--setenv' && i + 2 < args.length) {
          setenvEntries.push([args[i + 1]!, args[i + 2]!]);
        }
      }
      expect(setenvEntries).toContainEqual(['GIT_CONFIG_COUNT', '1']);
      expect(setenvEntries).toContainEqual(['GIT_CONFIG_KEY_0', 'safe.directory']);
      expect(setenvEntries).toContainEqual(['GIT_CONFIG_VALUE_0', '*']);
    });

    it('should not include git safe.directory config when no workspaceRoot', async () => {
      const args = await buildBubblewrapArgs({
        enabled: true,
        homeDir: '/tmp/h',
        networkAccess: false,
        dieWithParent: true,
      });

      const setenvEntries: [string, string][] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--setenv' && i + 2 < args.length) {
          setenvEntries.push([args[i + 1]!, args[i + 2]!]);
        }
      }
      expect(setenvEntries).not.toContainEqual(
        expect.arrayContaining(['GIT_CONFIG_COUNT']),
      );
    });

    it('should share .gitconfig via --ro-bind when the host file exists', async () => {
      const realHome = process.env['HOME'] ?? homedir();
      const gitconfigExists = existsSync(join(realHome, '.gitconfig'));

      if (!gitconfigExists) return;

      const args = await buildBubblewrapArgs({
        enabled: true,
        homeDir: '/tmp/test-home',
        networkAccess: false,
        dieWithParent: true,
      });

      // Look for --ro-bind <realHome>/.gitconfig /tmp/test-home/.gitconfig
      let found = false;
      for (let i = 0; i < args.length; i++) {
        if (
          args[i] === '--ro-bind' &&
          args[i + 1] === join(realHome, '.gitconfig') &&
          args[i + 2] === join('/tmp/test-home', '.gitconfig')
        ) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });
  });

  // ── findWorkspaceRoot integration against real repo ──────────────

  describe('findWorkspaceRoot: against real repo structure', () => {
    it('should find workspace root from a nested package directory', () => {
      // This test uses the actual repo root — findWorkspaceRoot should
      // discover .git or pnpm-workspace.yaml when walking up from here.
      const cwd = process.cwd();
      const detected = findWorkspaceRoot(cwd);
      expect(detected).toBeDefined();
      expect(detected).not.toBeUndefined();

      // The detected root should contain a workspace marker
      const hasGit = existsSync(join(detected!, '.git'));
      const hasPnpmWs = existsSync(join(detected!, 'pnpm-workspace.yaml'));
      expect(hasGit || hasPnpmWs).toBe(true);
    });

    it('should find workspace root from packages/kaos subdirectory', () => {
      const cwd = process.cwd();
      // Since we are in packages/kaos, simulate a deeper nested path
      const nestedPath = join(cwd, 'src');
      if (!existsSync(nestedPath)) return; // safety

      const detected = findWorkspaceRoot(nestedPath);
      expect(detected).toBeDefined();
    });
  });

  // ── SandboxKaos integration ──────────────────────────────────────

  describe('SandboxKaos with bubblewrap', () => {
    it('should execute commands through the sandbox wrapper', async () => {
      if (!bwrapReady) return;

      const workspaceRoot = makeBwrapSafeTmpDir();
      const homeDir = makeBwrapSafeTmpDir();
      const relCwd = 'work';

      mkdirSync(join(workspaceRoot, relCwd), { recursive: true });

      const inner = await LocalKaos.create();
      const config: BubblewrapIsolationConfig = {
        enabled: true,
        homeDir,
        networkAccess: false,
        dieWithParent: true,
        workspaceRoot,
        workspaceRelCwd: relCwd,
      };

      const sandbox = new SandboxKaos(inner, undefined, undefined, undefined, config);
      const proc = await sandbox.exec('pwd');
      const exitCode = await proc.wait();
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stdout) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const stdout = Buffer.concat(chunks).toString('utf8').trim();

      expect(exitCode).toBe(0);
      expect(stdout).toBe(`/workspace/${relCwd}`);
    });
  });
});

// ── Nix store binary runtime link validation ────────────────────────

describe('nix store binary runtime link validation', () => {
  let hasBwrap = false;

  beforeEach(async () => {
    hasBwrap = await isBubblewrapAvailable();
  });

  it.skipIf(!hasBwrap)(
    'should detect nix store path in buildBubblewrapArgs when PATH contains /nix/store',
    async () => {
      // Save original PATH and inject a /nix/store entry
      const origPath = process.env['PATH'] ?? '';
      process.env['PATH'] = '/nix/store/abc123/bin:' + origPath;

      try {
        const args = await buildBubblewrapArgs({
          enabled: true,
          homeDir: '/tmp/h',
          networkAccess: false,
          dieWithParent: true,
        });

        // Find --ro-bind /nix/store /nix/store
        let found = false;
        for (let i = 0; i < args.length; i++) {
          if (
            args[i] === '--ro-bind' &&
            args[i + 1] === '/nix/store' &&
            args[i + 2] === '/nix/store'
          ) {
            found = true;
            break;
          }
        }
        expect(found).toBe(true);
      } finally {
        process.env['PATH'] = origPath;
      }
    },
  );

  it.skipIf(!hasBwrap)(
    'should not add --ro-bind /nix/store when PATH has no /nix/store entries',
    async () => {
      // Save original PATH and strip any /nix/store entries
      const origPath = process.env['PATH'] ?? '';
      const cleanPath = origPath
        .split(':')
        .filter((p) => !p.startsWith('/nix/store/'))
        .join(':');
      process.env['PATH'] = cleanPath;

      try {
        const args = await buildBubblewrapArgs({
          enabled: true,
          homeDir: '/tmp/h',
          networkAccess: false,
          dieWithParent: true,
        });

        // Verify NO --ro-bind /nix/store /nix/store
        let found = false;
        for (let i = 0; i < args.length; i++) {
          if (
            args[i] === '--ro-bind' &&
            args[i + 1] === '/nix/store' &&
            args[i + 2] === '/nix/store'
          ) {
            found = true;
            break;
          }
        }
        expect(found).toBe(false);
      } finally {
        process.env['PATH'] = origPath;
      }
    },
  );

  it('should include extraEnv and clearEnv in BubblewrapIsolationConfig', () => {
    // Type-level check: verify the config interface accepts extraEnv and clearEnv
    const config: BubblewrapIsolationConfig = {
      enabled: true,
      homeDir: '/tmp/h',
      networkAccess: false,
      dieWithParent: true,
      extraEnv: { FOO: 'bar', BAZ: 'qux' },
      clearEnv: true,
    };
    expect(config.extraEnv).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(config.clearEnv).toBe(true);
  });

  it('should produce --setenv for each extraEnv entry', async () => {
    const args = await buildBubblewrapArgs({
      enabled: true,
      homeDir: '/tmp/h',
      networkAccess: false,
      dieWithParent: true,
      extraEnv: { MY_VAR: 'hello', ANOTHER: 'world' },
    });

    const setenvEntries: [string, string][] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--setenv' && i + 2 < args.length) {
        setenvEntries.push([args[i + 1]!, args[i + 2]!]);
      }
    }
    expect(setenvEntries).toContainEqual(['MY_VAR', 'hello']);
    expect(setenvEntries).toContainEqual(['ANOTHER', 'world']);
  });

  it('should produce --clearenv when clearEnv is set and no nix env detected', async () => {
    // Ensure no nix store on this system so detectNixDevShellEnv returns undefined
    const origPath = process.env['PATH'] ?? '';
    const cleanPath = origPath
      .split(':')
      .filter((p) => !p.startsWith('/nix/store/'))
      .join(':');
    process.env['PATH'] = cleanPath;

    try {
      const args = await buildBubblewrapArgs({
        enabled: true,
        homeDir: '/tmp/h',
        networkAccess: false,
        dieWithParent: true,
        clearEnv: true,
      });

      expect(args).toContain('--clearenv');
      // After --clearenv, HOME and TERM should be re-set
      const setenvEntries: [string, string][] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--setenv' && i + 2 < args.length) {
          setenvEntries.push([args[i + 1]!, args[i + 2]!]);
        }
      }
      expect(setenvEntries).toContainEqual(['HOME', '/tmp/h']);
    } finally {
      process.env['PATH'] = origPath;
    }
  });

  it('should not produce --clearenv when clearEnv is false and no nix env', async () => {
    const args = await buildBubblewrapArgs({
      enabled: true,
      homeDir: '/tmp/h',
      networkAccess: false,
      dieWithParent: true,
      clearEnv: false,
    });

    // Only the auto-detect nix path could inject --clearenv; with clearEnv=false
    // and no nix env, it should not appear. On a nix system the auto-detect path
    // might still add it, so only assert absence when /nix/store is not present.
    let hasNixStoreBind = false;
    for (let i = 0; i < args.length; i++) {
      if (
        args[i] === '--ro-bind' &&
        args[i + 1] === '/nix/store' &&
        args[i + 2] === '/nix/store'
      ) {
        hasNixStoreBind = true;
        break;
      }
    }
    if (!hasNixStoreBind) {
      expect(args).not.toContain('--clearenv');
    }
  });
});
