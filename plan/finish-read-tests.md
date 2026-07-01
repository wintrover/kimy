# Plan: Finish read.test.ts Coercion + Alias Test Cases

## Context

Tasks A–D are complete and verified ✅. Task E (add tests to `read.test.ts`) timed out with no output. The test file already has metadata tests at the end but lacks:

1. **Coercion tests**: Verify `ReadInputSchema` coerces string `"5"` → number `5` for `line_offset` and `n_lines`
2. **Alias tests**: Verify `preflightToolCall` resolves `{ offset: 5 }` → `{ line_offset: 5 }` before validation
3. **Integration test**: Verify the full pipeline (alias → Zod coercion → ReadTool execution) works end-to-end

### Verified code state (Tasks A–D)

| File | Changes | Status |
|------|---------|--------|
| `read.ts` | `z.overwrite()` coercion, `inputSchema`, `metadata` | ✅ |
| `types.ts` | `ToolMetadata`, `ExecutableTool` extensions | ✅ |
| `tool-call.ts` | `resolveAliases`, Zod-first `preflightToolCall` | ✅ |
| `args-validator.ts` | `formatZodError` export | ✅ |

## Steps

### Step 1: ~~Verify current code state~~ ✅ Done

### Step 2: Add tests to `read.test.ts`

Append these test cases at the end of the file (after the existing `ReadTool metadata` describe block):

```typescript
describe('ReadInputSchema coercion', () => {
  it('should coerce string line_offset to number', () => {
    const result = ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: '5' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.line_offset).toBe(5);
  });

  it('should coerce string n_lines to number', () => {
    const result = ReadInputSchema.safeParse({ path: '/tmp/test.txt', n_lines: '10' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.n_lines).toBe(10);
  });

  it('should coerce negative string line_offset to number', () => {
    const result = ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: '-100' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.line_offset).toBe(-100);
  });

  it('should reject non-numeric string line_offset', () => {
    const result = ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: 'abc' });
    expect(result.success).toBe(false);
  });

  it('should coerce both string fields simultaneously', () => {
    const result = ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: '3', n_lines: '20' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line_offset).toBe(3);
      expect(result.data.n_lines).toBe(20);
    }
  });
});

describe('ReadTool inputSchema validation', () => {
  it('should accept valid object with numeric line_offset', () => {
    const fakeKaos = createFakeKaos({ '/tmp/test.txt': 'line1\nline2\n' });
    const tool = new ReadTool(fakeKaos, PERMISSIVE_WORKSPACE);
    const result = (tool.inputSchema as any).safeParse({ path: '/tmp/test.txt', line_offset: 2 });
    expect(result.success).toBe(true);
  });

  it('should accept valid object without optional fields', () => {
    const fakeKaos = createFakeKaos({ '/tmp/test.txt': 'line1\n' });
    const tool = new ReadTool(fakeKaos, PERMISSIVE_WORKSPACE);
    const result = (tool.inputSchema as any).safeParse({ path: '/tmp/test.txt' });
    expect(result.success).toBe(true);
  });

  it('should reject missing required path field', () => {
    const fakeKaos = createFakeKaos({});
    const tool = new ReadTool(fakeKaos, PERMISSIVE_WORKSPACE);
    const result = (tool.inputSchema as any).safeParse({});
    expect(result.success).toBe(false);
  });
});
```

### Step 3: Run the test file

```bash
cd /home/wintrover/.kimi-code/src/kimi-code
pnpm vitest run packages/agent-core/test/tools/read.test.ts
```

### Step 4: Fix any failures

If tests fail due to schema structure differences (e.g., `z.overwrite()` changes parse behavior), adjust assertions accordingly.

### Step 5: Run broader test suite

```bash
pnpm vitest run packages/agent-core/test/loop/tool-call.test.ts
pnpm vitest run packages/agent-core/test/tools/
```

## Risks

- `z.overwrite()` coercion may not trigger on `.safeParse()` — need to verify the coercion actually works at the Zod level
- The `preflightToolCall` alias test may need a mock tool with `metadata.paramAliases` — if the existing `tool-call.test.ts` doesn't have Read tool tests, we add them there instead

## Verification

All tests pass:
```
✓ read.test.ts (coercion + metadata + alias tests)
✓ tool-call.test.ts (alias resolution path)
```
