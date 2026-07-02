import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/wintrover/.kimi-code/src/kimi-code/src';
const CONFIG = '/home/wintrover/.kimi-code/config.toml';

function importFromUri(uri) {
  return import(uri);
}

function importFromRepo(pathInRepo) {
  return importFromUri('file://' + join(REPO, pathInRepo));
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

async function main() {
  const [{ default: mapping }, { default: scoreData }] = await Promise.all([
    importFromRepo('tui/data/model-id-mapping.json'),
    importFromRepo('tui/data/model-benchmark-scores.json'),
  ]);

  const MODEL_BENCHMARK_SCORES = scoreData.scores || {};
  const MODEL_ID_MAPPING = mapping || {};
  const MODEL_TIERS = scoreData.modelTiers || {};
  const PURGED_MODELS = (scoreData.purgedModels || []) as string[];
  const MODEL_PROXY_SOURCES = scoreData.proxySources || {};

  const SCORE_BY_LOWER = new Map(
    Object.entries(MODEL_BENCHMARK_SCORES).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const PURGED_LOWER = new Set(PURGED_MODELS.map((m) => m.toLowerCase()));

  function findOriginalKey(lower: string): string | undefined {
    for (const key of Object.keys(MODEL_BENCHMARK_SCORES)) {
      if (key.toLowerCase() === lower) return key;
    }
    return undefined;
  }

  function isPurgedModel(alias: string): boolean {
    return PURGED_LOWER.has(alias.toLowerCase());
  }

  function lookupBenchmarkScore(
    alias: string,
    model: { model?: string; displayName?: string },
  ):
    | { score: number; tier: number; proxySource?: string }
    | undefined {
    if (isPurgedModel(alias)) return undefined;
    const mappedId = MODEL_ID_MAPPING[alias];
    if (mappedId !== undefined) {
      const score = MODEL_BENCHMARK_SCORES[mappedId];
      if (score !== undefined) {
        const proxySource = MODEL_PROXY_SOURCES[mappedId];
        return {
          score,
          tier: (MODEL_TIERS[mappedId] ?? 1) as number,
          ...(proxySource !== undefined ? { proxySource } : {}),
        };
      }
      const lower = SCORE_BY_LOWER.get(mappedId.toLowerCase());
      if (lower !== undefined) {
        const originalKey = findOriginalKey(mappedId.toLowerCase());
        const proxySource =
          originalKey !== undefined ? MODEL_PROXY_SOURCES[originalKey] : undefined;
        return {
          score: lower,
          tier: ((originalKey !== undefined ? MODEL_TIERS[originalKey] : undefined) ?? 1) as number,
          ...(proxySource !== undefined ? { proxySource } : {}),
        };
      }
    }

    const aliasLower = SCORE_BY_LOWER.get(alias.toLowerCase());
    if (aliasLower !== undefined) {
      const originalKey = findOriginalKey(alias.toLowerCase());
      const proxySource =
        originalKey !== undefined ? MODEL_PROXY_SOURCES[originalKey] : undefined;
      return {
        score: aliasLower,
        tier: ((originalKey !== undefined ? MODEL_TIERS[originalKey] : undefined) ?? 1) as number,
        ...(proxySource !== undefined ? { proxySource } : {}),
      };
    }

    const modelId = model?.model;
    if (modelId !== undefined) {
      const modelLower = SCORE_BY_LOWER.get(modelId.toLowerCase());
      if (modelLower !== undefined) {
        const originalKey = findOriginalKey(modelId.toLowerCase());
        const proxySource =
          originalKey !== undefined ? MODEL_PROXY_SOURCES[originalKey] : undefined;
        return {
          score: modelLower,
          tier: ((originalKey !== undefined ? MODEL_TIERS[originalKey] : undefined) ?? 1) as number,
          ...(proxySource !== undefined ? { proxySource } : {}),
        };
      }
    }

    return undefined;
  }

  function sortModelsByBenchmark(
    entries: [string, { model?: string; displayName?: string }][],
  ): [string, { model?: string; displayName?: string }][] {
    const scored: { entry: [string, { model?: string; displayName?: string }]; score: number }[] =
      [];
    const unscored: [string, { model?: string; displayName?: string }][] = [];

    for (const entry of entries) {
      const [alias, model] = entry;
      const result = lookupBenchmarkScore(alias, model);
      if (result !== undefined) {
        scored.push({ entry, score: result.score });
      } else {
        unscored.push(entry);
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return [...scored.map((s) => s.entry), ...unscored];
  }

  function sortAndTierModels(
    entries: [string, { model?: string; displayName?: string }][],
  ): Record<string, { model?: string; displayName?: string }> {
    const filtered = entries.filter(([alias]) => !isPurgedModel(alias));
    const sorted = sortModelsByBenchmark(filtered);
    const withTiers = sorted.map(([alias, model]) => {
      const result = lookupBenchmarkScore(alias, model);
      const baseName = model?.displayName ?? alias;
      const cleanName = baseName.replace(/[†‡]+$/, '');
      if (result !== undefined && result.tier === 2) {
        return [
          alias,
          { ...model, displayName: `${cleanName}†` },
        ] as [string, { model?: string; displayName?: string }];
      }
      if (result !== undefined && result.tier === 3) {
        return [
          alias,
          { ...model, displayName: `${cleanName}‡` },
        ] as [string, { model?: string; displayName?: string }];
      }
      return [
        alias,
        { ...model, displayName: cleanName },
      ] as [string, { model?: string; displayName?: string }];
    });
    return Object.fromEntries(withTiers);
  }

  function parseConfigModels(): Record<
    string,
    { model?: string; displayName?: string; capabilities?: string[] }
  > {
    const parsed = parseToml(readFileSync(CONFIG, 'utf-8'));
    const entries = parsed.models || {};
    const out: Record<
      string,
      { model?: string; displayName?: string; capabilities?: string[] }
    > = {};
    for (const [alias, value] of Object.entries(entries)) {
      if (typeof value === 'object' && value !== null) {
        const casted = value as Record<
          string,
          unknown
        > & {
          capabilities?: string[];
        };
        out[alias] = {
          model: typeof casted.model === 'string' ? casted.model : undefined,
          displayName: typeof casted.displayName === 'string' ? casted.displayName : undefined,
          capabilities: Array.isArray(casted.capabilities) ? casted.capabilities : undefined,
        };
      }
    }
    return out;
  }

  function parseToml(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentTable: Record<string, unknown> | null = null;
    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const topTableMatch = line.match(/^\[([^\]]+)\]$/);
      if (topTableMatch) {
        const tableKey = topTableMatch[1].trim();
        if (!result[tableKey]) {
          result[tableKey] = {};
        }
        if (typeof result[tableKey] === 'object' && result[tableKey] !== null) {
          currentTable = result[tableKey] as Record<string, unknown>;
        }
        continue;
      }

      const kvMatch = line.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        const valuePart = kvMatch[2].trim();
        const value = parseTomlValue(valuePart);
        if (currentTable !== null && key.includes('.')) {
          const [head, ...rest] = key.split('.');
          let target: Record<string, unknown> = currentTable;
          for (let i = 0; i < rest.length - 1; i += 1) {
            if (!target[rest[i]]) {
              target[rest[i]] = {};
            }
            if (typeof target[rest[i]] === 'object' && target[rest[i]] !== null) {
              target = target[rest[i]] as Record<string, unknown>;
            }
          }
          target[rest[rest.length - 1]] = value;
        } else if (currentTable !== null) {
          currentTable[key] = value;
        } else {
          result[key] = value;
        }
        continue;
      }
    }
    return result;
  }

  function parseTomlValue(value: string): unknown {
    if (value.startsWith('[')) {
      try {
        return JSON.parse(value);
      } catch (error: unknown) {
        return [];
      }
    }

    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    if (value.startsWith('"')) {
      return value.slice(1, value.endsWith('"') ? -1 : value.length);
    }

    return value;
  }

  const allModels = parseConfigModels();
  console.log(`Total config models: ${Object.keys(allModels).length}`);

  const nvidiaEntries = Object.entries(allModels).filter(([, m]) => m.provider === 'nvidia');
  console.log(`NVIDIA provider models: ${nvidiaEntries.length}`);

  const allTabs = sortAndTierModels(Object.entries(allModels));
  console.log('\n=== ALL TAB (sorted by score desc, purged excluded, tier badges applied) ===\n');
  for (const [alias, model] of Object.entries(allTabs)) {
    const result = lookupBenchmarkScore(alias, model);
    const score = result?.score !== undefined ? `${(result.score * 100).toFixed(1)}%` : 'N/A';
    const tier = result?.tier != null ? `Tier ${result.tier}` : 'N/A';
    const proxy = result?.proxySource ? ` proxy=${result.proxySource}` : '';
    console.log(`  ${model?.displayName ?? alias}\n    | alias: ${alias}\n    | score: ${score}\n    | tier: ${tier}${proxy}`);
  }

  const nvidiaTabs = sortAndTierModels(nvidiaEntries);
  console.log('\n=== NVIDIA TAB (sorted by score desc, purged excluded, tier badges applied) ===\n');
  for (const [alias, model] of Object.entries(nvidiaTabs)) {
    const result = lookupBenchmarkScore(alias, model);
    const score = result?.score !== undefined ? `${(result.score * 100).toFixed(1)}%` : 'N/A';
    const tier = result?.tier != null ? `Tier ${result.tier}` : 'N/A';
    const proxy = result?.proxySource ? ` proxy=${result.proxySource}` : '';
    console.log(`  ${model?.displayName ?? alias}\n    | alias: ${alias}\n    | score: ${score}\n    | tier: ${tier}${proxy}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
