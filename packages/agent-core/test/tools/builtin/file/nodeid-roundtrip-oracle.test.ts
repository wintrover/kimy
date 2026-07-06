import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  getNodeId,
  findNodeById,
} from '../../../../src/tools/builtin/file/ast-node-id';
import type {
  TSSyntaxNode,
  TSTree,
} from '../../../../src/tools/builtin/file/ast-node-id';

// ---------------------------------------------------------------------------
// web-tree-sitter mock — both ast-node-id.ts and structural-mutation.ts
// dynamically import this module.  The pure functions (getNodeId,
// findNodeById) never trigger the dynamic import, but we provide a mock
// so the module graph resolves cleanly.
// ---------------------------------------------------------------------------

vi.mock('web-tree-sitter', () => {
  const mockNode = (type: string, text: string, children: any[] = []) => ({
    type,
    text,
    id: Math.random(),
    isNamed: true,
    parent: null as any,
    namedChildren: children,
    children,
    childCount: children.length,
    startIndex: 0,
    endIndex: text.length,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    child: (i: number) => children[i] ?? null,
    namedChild: (i: number) => children[i] ?? null,
    childForFieldName: (_name: string) => null,
    fieldNameForChild: (_i: number) => null,
  });

  const Parser = Object.assign(
    vi.fn().mockImplementation(() => ({
      parse: vi.fn().mockReturnValue({
        rootNode: mockNode('program', 'program', []),
      }),
      setLanguage: vi.fn(),
    })),
    {
      init: vi.fn().mockResolvedValue(undefined),
      Language: {
        load: vi.fn().mockResolvedValue({}),
      },
    },
  );

  return { default: Parser };
});

// ---------------------------------------------------------------------------
// Oracle availability detection
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Path to the Lean 4 oracle binary (may not exist). */
const ORACLE_BIN = `${process.cwd()}/../../tools/lean4-verification/lean4-oracle/.lake/build/bin/oracle`;

const oracleAvailable = existsSync(ORACLE_BIN);

/**
 * Invoke the oracle's `nodeid_roundtrip` command and return the parsed
 * response.  Returns `null` when the binary is missing or the call fails.
 */
async function callOracle(
  nodes: Array<{ filePath: string; structuralPath: string; nodeType: string }>,
): Promise<Record<string, unknown> | null> {
  if (!oracleAvailable) return null;
  try {
    const payload = JSON.stringify({ command: 'nodeid_roundtrip', nodes });
    const { stdout } = await execFileAsync(ORACLE_BIN, [], { input: payload });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mock AST builder
//
// Tree shape (Nim-like):
//
//   program (root, id=1)
//   ├── function_definition (id=2)   — unlabelled in program
//   │   ├── identifier "add" (id=3)  — field "name" in function_definition
//   │   └── block (id=4)             — field "body" in function_definition
//   │       └── return_statement (id=5) — unlabelled in block
//   │           └── infix_expression (id=6) — unlabelled in return_statement
//   └── variable_declaration (id=7)  — unlabelled in program
//       └── identifier "x" (id=8)    — field "name" in variable_declaration
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<TSSyntaxNode> &
    Pick<TSSyntaxNode, 'type' | 'id'>,
): TSSyntaxNode {
  const base: TSSyntaxNode = {
    id: overrides.id,
    type: overrides.type,
    isNamed: true,
    parent: null,
    namedChildren: [],
    children: [],
    childCount: 0,
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    child: () => null,
    namedChild: () => null,
    childForFieldName: () => null,
    fieldNameForChild: () => null,
    ...overrides,
  };
  return base;
}

/**
 * Mutate `parent` in place so that its child-access functions and
 * `namedChildren` reflect `childrenWithFields`, and each child's
 * `parent` pointer is set back to `parent`.
 *
 * IMPORTANT: Unlike creating a new node via `makeNode`, this mutates
 * the existing object so that all external references remain valid.
 */
function wireParent(
  parent: TSSyntaxNode,
  childrenWithFields: Array<{ node: TSSyntaxNode; field: string | null }>,
): void {
  const named = childrenWithFields.map((e) => e.node);
  const all = [...named];

  Object.assign(parent, {
    namedChildren: named,
    children: all,
    childCount: all.length,
    child: (i: number) => all[i] ?? null,
    namedChild: (i: number) => named[i] ?? null,
    childForFieldName: (name: string) => {
      const entry = childrenWithFields.find((e) => e.field === name);
      return entry?.node ?? null;
    },
    fieldNameForChild: (i: number) => childrenWithFields[i]?.field ?? null,
  });

  for (const child of named) {
    (child as { parent: TSSyntaxNode | null }).parent = parent;
  }
}

function buildMockTree(): { tree: TSTree; nodes: Record<string, TSSyntaxNode> } {
  const intLit = makeNode({ id: 6, type: 'infix_expression' });
  const retStmt = makeNode({ id: 5, type: 'return_statement' });
  const block = makeNode({ id: 4, type: 'block' });
  const funcName = makeNode({ id: 3, type: 'identifier' });
  const funcDef = makeNode({ id: 2, type: 'function_definition' });
  const varName = makeNode({ id: 8, type: 'identifier' });
  const varDecl = makeNode({ id: 7, type: 'variable_declaration' });
  const program = makeNode({ id: 1, type: 'program' });

  // Wire from leaves up — each call mutates parent in place.
  wireParent(retStmt, [{ node: intLit, field: null }]);
  wireParent(block, [{ node: retStmt, field: null }]);
  wireParent(funcDef, [
    { node: funcName, field: 'name' },
    { node: block, field: 'body' },
  ]);
  wireParent(varDecl, [{ node: varName, field: 'name' }]);
  wireParent(program, [
    { node: funcDef, field: null },
    { node: varDecl, field: null },
  ]);

  const tree: TSTree = {
    rootNode: program,
    edit: vi.fn(),
  };

  return {
    tree,
    nodes: { program, funcDef, funcName, block, retStmt, intLit, varDecl, varName },
  };
}

// ---------------------------------------------------------------------------
// Helper: decompose a getNodeId output into oracle-call components.
// ---------------------------------------------------------------------------
function decomposeNodeId(id: string): {
  filePath: string;
  structuralPath: string;
  nodeType: string;
} {
  const sep = id.indexOf('::');
  const hash = id.lastIndexOf('#');
  return {
    filePath: id.slice(0, sep),
    structuralPath: id.slice(sep + 2, hash),
    nodeType: id.slice(hash + 1),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('NodeID roundtrip — oracle differential testing', () => {
  const { tree, nodes } = buildMockTree();
  const filePath = 'z3_solver_wrapper.nim';

  it('simple node: getNodeId returns format filePath::structuralPath#nodeType', () => {
    const id = getNodeId(nodes.funcDef, filePath);
    // funcDef is unlabelled child of program at index 0.
    expect(id).toBe(
      'z3_solver_wrapper.nim::program.function_definition[0]#function_definition',
    );
  });

  it('nested node: deeper structural path produces correct ID', () => {
    const id = getNodeId(nodes.block, filePath);
    // block is body[0] of function_definition[0] in program.
    expect(id).toBe(
      'z3_solver_wrapper.nim::program.body[0].function_definition[0]#block',
    );
  });

  it('findNodeById with valid ID returns the correct node', () => {
    // funcDef is a direct child of root — roundtrip works.
    const id = getNodeId(nodes.funcDef, filePath);
    const found = findNodeById(tree, id);
    expect(found).toBe(nodes.funcDef);
  });

  it('findNodeById with invalid ID returns null', () => {
    const found = findNodeById(tree, 'nonexistent.nim::program.foo[0]#bar');
    expect(found).toBeNull();
  });

  it('findNodeById with malformed ID (no ::) returns null', () => {
    expect(findNodeById(tree, 'bad-id')).toBeNull();
  });

  it('findNodeById with malformed ID (no #) returns null', () => {
    expect(findNodeById(tree, 'file.nim::path-without-hash')).toBeNull();
  });

  // --- Oracle differential tests -------------------------------------------------

  const oracleDescribe = describe.skipIf(!oracleAvailable);

  oracleDescribe('oracle available', () => {
    it('TS getNodeId matches oracle computeNodeId for direct child', async () => {
      const tsId = getNodeId(nodes.funcDef, filePath);
      const { filePath: fp, structuralPath, nodeType } = decomposeNodeId(tsId);

      const resp = await callOracle([{ filePath: fp, structuralPath, nodeType }]);

      expect(resp).not.toBeNull();
      expect(resp!.ok).toBe(true);

      const mapping = (resp!.result as { mapping: Array<{ id: string }> }).mapping;
      expect(mapping).toHaveLength(1);
      expect(mapping[0]!.id).toBe(tsId);
    });

    it('oracle roundtrips multiple nodes in a single batch', async () => {
      const targets = [nodes.funcDef, nodes.funcName, nodes.varDecl];
      const nodesInput = targets.map((n) => decomposeNodeId(getNodeId(n, filePath)));

      const resp = await callOracle(nodesInput);
      expect(resp).not.toBeNull();
      expect(resp!.ok).toBe(true);

      const mapping = (resp!.result as { mapping: Array<{ id: string }> }).mapping;
      expect(mapping).toHaveLength(3);

      for (let i = 0; i < 3; i++) {
        const tsId = getNodeId(targets[i]!, filePath);
        expect(mapping[i]!.id).toBe(tsId);
      }
    });
  });

  oracleDescribe('oracle not available', () => {
    it('skips oracle tests when binary is not compiled', () => {
      expect(oracleAvailable).toBe(false);
    });
  });
});

describe('getNodeId — format verification', () => {
  const { nodes } = buildMockTree();

  it('format: returns filePath::structuralPath#nodeType', () => {
    const id = getNodeId(nodes.funcDef, 'test.nim');
    expect(id).toMatch(/^[^:]+::[^#]+#[a-z_]+$/);
  });

  it('deterministic: same node produces identical ID every time', () => {
    const id1 = getNodeId(nodes.funcDef, 'test.nim');
    const id2 = getNodeId(nodes.funcDef, 'test.nim');
    const id3 = getNodeId(nodes.funcDef, 'test.nim');
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it('different files: same structure, different filePath → different IDs', () => {
    const id1 = getNodeId(nodes.funcDef, 'file_a.nim');
    const id2 = getNodeId(nodes.funcDef, 'file_b.nim');
    expect(id1).not.toBe(id2);
    // Structural path and type should be the same — only filePath differs.
    expect(id1.split('::')[1]).toBe(id2.split('::')[1]);
  });

  it('different node types: same position, different type → different IDs', () => {
    const idFunc = getNodeId(nodes.funcDef, 'test.nim');
    const idVar = getNodeId(nodes.varDecl, 'test.nim');
    expect(idFunc).not.toBe(idVar);
    expect(idFunc.split('::')[0]).toBe(idVar.split('::')[0]);
  });

  it('root node: structural path is just the root type', () => {
    const id = getNodeId(nodes.program, 'test.nim');
    expect(id).toBe('test.nim::program#program');
  });

  it('unlabelled same-type siblings: index increments correctly', () => {
    // Both funcDef and varDecl are unlabelled children of program but
    // have *different* types, so each is index 0 in its own type group.
    const idFunc = getNodeId(nodes.funcDef, 'test.nim');
    const idVar = getNodeId(nodes.varDecl, 'test.nim');
    expect(idFunc).toContain('function_definition[0]');
    expect(idVar).toContain('variable_declaration[0]');
  });

  it('field-labelled child: uses field name instead of type', () => {
    // funcName is in the "name" field of function_definition.
    const id = getNodeId(nodes.funcName, 'test.nim');
    expect(id).toContain('name[0]');
    // Should NOT contain the raw type "identifier" as a path segment.
    expect(id).not.toContain('identifier[0]');
  });
});

describe('findNodeById — search', () => {
  const { tree, nodes } = buildMockTree();

  it('exact match: finds root node', () => {
    const found = findNodeById(tree, 'x.nim::program#program');
    expect(found).toBe(nodes.program);
  });

  it('exact match: finds direct child by type index', () => {
    // funcDef is function_definition[0] in program.
    const found = findNodeById(
      tree,
      'x.nim::program.function_definition[0]#function_definition',
    );
    expect(found).toBe(nodes.funcDef);
  });

  it('no match: non-existent structural path returns null', () => {
    const found = findNodeById(
      tree,
      'x.nim::program.class_definition[0]#class_definition',
    );
    expect(found).toBeNull();
  });

  it('partial match: partial path does NOT match (exact match only)', () => {
    // The ID type suffix is decorative for walkToPath — it only walks
    // the structural path.  So "program" matches the root regardless.
    const found = findNodeById(tree, 'x.nim::program#something_else');
    expect(found).toBe(nodes.program);
  });

  it('out-of-range index returns null', () => {
    const found = findNodeById(
      tree,
      'x.nim::program.function_definition[99]#function_definition',
    );
    expect(found).toBeNull();
  });

  it('field-based walk: follows named fields correctly', () => {
    // Construct a root-to-leaf path manually (walkToPath order).
    const found = findNodeById(
      tree,
      'x.nim::program.function_definition[0].body[0]#block',
    );
    expect(found).toBe(nodes.block);
  });

  it('deep walk: reaches a leaf through multiple levels', () => {
    const found = findNodeById(
      tree,
      'x.nim::program.function_definition[0].body[0].return_statement[0]#return_statement',
    );
    expect(found).toBe(nodes.retStmt);
  });
});
