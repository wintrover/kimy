import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;
const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const optionalNativeDependencies = new Set(['cpu-features']);

function shouldAlwaysBundle(id: string): boolean {
  if (builtins.has(id) || id.startsWith('node:')) return false;
  if (optionalNativeDependencies.has(id)) return false;
  // Everything else is force-bundled, which covers `@moonshot-ai/*` (incl.
  // vis-server for `kimi vis`) plus its transitive `hono` / `@hono/node-server`
  // — so the SEA bundle is self-contained (check-bundle.mjs enforces this).
  return true;
}

function buildTarget(): string {
  return process.env['KIMI_CODE_BUILD_TARGET'] ?? `${process.platform}-${process.arch}`;
}

/**
 * Rolldown plugin that writes a build manifest after each successful build.
 * The manifest lists the actual source files bundled into the output,
 * enabling the kimi wrapper to hash only files that matter.
 */
function manifestPlugin(): import('tsdown').TsdownPlugin {
  const manifestDir = resolve(appRoot, 'dist-native/intermediates');
  return {
    name: 'build-manifest',
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const [, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          for (const moduleId of (output as { moduleIds?: string[] }).moduleIds ?? []) {
            if (!moduleId.includes('node_modules') && !moduleId.startsWith('\0')) {
              modules.add(moduleId);
            }
          }
        }
      }
      const manifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        entry: './src/main.ts',
        bundledModules: [...modules].sort(),
        configFiles: [
          'tsdown.native.config.ts',
          'scripts/built-in-catalog.mjs',
          '../../build/raw-text-plugin.mjs',
        ],
      };
      const manifestPath = `${manifestDir}/build-manifest.json`;
      const tmpPath = `${manifestPath}.tmp.${process.pid}`;
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
      renameSync(tmpPath, manifestPath);
    },
  };
}

export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['cjs'],
  outDir: 'dist-native/intermediates',
  clean: true,
  dts: false,
  fixedExtension: true,
  hash: false,
  platform: 'node',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  plugins: [rawTextPlugin(), manifestPlugin()],
  alias: {
    '@': resolve(appRoot, 'src'),
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
    __KIMI_CODE_VERSION__: JSON.stringify(packageJson.version),
    __KIMI_CODE_CHANNEL__: JSON.stringify(process.env['KIMI_CODE_CHANNEL'] ?? ''),
    __KIMI_CODE_COMMIT__: JSON.stringify(process.env['KIMI_CODE_COMMIT'] ?? ''),
    __KIMI_CODE_BUILD_TARGET__: JSON.stringify(buildTarget()),
    __KIMI_CODE_NATIVE_BUNDLE__: 'true',
  },
  deps: {
    alwaysBundle: shouldAlwaysBundle,
    neverBundle: [...optionalNativeDependencies],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.cjs',
  },
  checks: {
    legacyCjs: false,
  },
});
