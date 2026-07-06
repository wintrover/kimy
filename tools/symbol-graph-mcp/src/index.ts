#!/usr/bin/env node

/**
 * Symbol Dependency Graph — MCP Server
 *
 * Exposes two tools over the MCP stdio transport:
 *   1. `symbol_query`  — look up a single symbol and its dependency subtree.
 *   2. `graph_slice`   — extract a multi-symbol subgraph with contracts.
 *
 * Internally delegates to the nif-extractor (S4) for semantic data, then
 * transforms the NIF output into the compact contract format agents inject
 * into their context windows.
 *
 * Usage (stdio):
 *   node dist/index.js [--daemon-url http://127.0.0.1:9527]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  querySymbol,
  querySymbolsBatch,
  type NifExtractorConfig,
} from './nif-extractor-client.js';
import { buildSymbolQueryResult, buildGraphSlice } from './graph.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): NifExtractorConfig {
  const config: NifExtractorConfig = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--daemon-url' && argv[i + 1] !== undefined) {
      config.daemonUrl = argv[++i];
    }
    if (argv[i] === '--timeout' && argv[i + 1] !== undefined) {
      config.timeoutMs = Number(argv[++i]);
    }
  }
  return config;
}

const nifConfig: NifExtractorConfig = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'symbol-graph-mcp',
  version: '0.1.0',
});

// --- Tool: symbol_query -------------------------------------------------

server.tool(
  'symbol_query',
  'Query a single symbol by fully-qualified name. Returns the symbol node, ' +
    'its dependency edges, contract descriptor, and optional macro expansion.',
  {
    fqn: z.string().describe('Fully-qualified symbol name, e.g. "src/agent/Agent.runTurn"'),
    depth: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(2)
      .describe('How many hops into the dependency graph to traverse (0 = direct deps only)'),
    project_path: z.string().describe('Absolute path to the project root'),
  },
  async ({ fqn, depth, project_path }) => {
    try {
      const rawSymbols = await querySymbol(fqn, project_path, depth, nifConfig);

      if (rawSymbols.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: `Symbol not found: ${fqn}` }),
            },
          ],
          isError: true,
        };
      }

      const root = rawSymbols.find((s) => s.fqn === fqn) ?? rawSymbols[0];
      const result = buildSymbolQueryResult(root, rawSymbols);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  },
);

// --- Tool: graph_slice ---------------------------------------------------

server.tool(
  'graph_slice',
  'Extract a subgraph containing the given symbols and their transitive ' +
    'dependencies within the specified depth. Returns nodes, edges, and contracts.',
  {
    symbols: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe('List of fully-qualified symbol names to include in the slice'),
    depth: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(2)
      .describe('How many hops into the dependency graph to traverse from each seed'),
    project_path: z.string().describe('Absolute path to the project root'),
  },
  async ({ symbols, depth, project_path }) => {
    try {
      const rawSymbols = await querySymbolsBatch(symbols, project_path, depth, nifConfig);

      if (rawSymbols.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'No symbols found for the given inputs' }),
            },
          ],
          isError: true,
        };
      }

      const result = buildGraphSlice(symbols, rawSymbols, depth);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now listening on stdin/stdout; stderr stays free for diagnostics.
}

main().catch((err) => {
  console.error('symbol-graph-mcp: fatal startup error', err);
  process.exit(1);
});
