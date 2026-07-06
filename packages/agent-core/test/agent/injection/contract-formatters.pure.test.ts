import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  formatContractConstitution,
  formatSingleContract,
  type AgentContract,
  type EffectPragma,
} from '../../../src/agent/injection/contract-formatters.pure';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<AgentContract> = {}): AgentContract {
  return {
    symbol: 'src/foo.ts:Bar',
    typeSignature: '(x: number) => void',
    effectPragma: [],
    prohibitedEffects: [],
    mutableInterface: [],
    immutableInterface: [],
    invariants: [],
    durability: 'transient',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatSingleContract
// ---------------------------------------------------------------------------

describe.concurrent('formatSingleContract', () => {
  it('returns empty string for null', () => {
    expect(formatSingleContract(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatSingleContract(undefined)).toBe('');
  });

  it('renders a minimal contract', () => {
    const c = makeContract();
    const result = formatSingleContract(c);
    expect(result).toContain('### src/foo.ts:Bar');
    expect(result).toContain('- **Signature:** `(x: number) => void`');
    expect(result).toContain('- **Durability:** transient');
  });

  it('includes effect pragma when present', () => {
    const c = makeContract({ effectPragma: ['io', 'network'] });
    const result = formatSingleContract(c);
    expect(result).toContain('- **Allowed effects:** io, network');
  });

  it('omits effect pragma when empty', () => {
    const c = makeContract({ effectPragma: [] });
    const result = formatSingleContract(c);
    expect(result).not.toContain('Allowed effects');
  });

  it('includes prohibited effects when present', () => {
    const c = makeContract({ prohibitedEffects: ['fs-write', 'mutation'] });
    const result = formatSingleContract(c);
    expect(result).toContain('- **Prohibited effects:** fs-write, mutation');
  });

  it('includes mutable and immutable interface lines', () => {
    const c = makeContract({
      mutableInterface: ['state'],
      immutableInterface: ['id', 'name'],
    });
    const result = formatSingleContract(c);
    expect(result).toContain('- **Mutable:** state');
    expect(result).toContain('- **Immutable:** id, name');
  });

  it('renders invariants as bullet list', () => {
    const c = makeContract({ invariants: ['must commit', 'no side effects'] });
    const result = formatSingleContract(c);
    expect(result).toContain('- **Invariants:**');
    expect(result).toContain('  - must commit');
    expect(result).toContain('  - no side effects');
  });

  it('omits invariant section when empty', () => {
    const c = makeContract({ invariants: [] });
    const result = formatSingleContract(c);
    expect(result).not.toContain('Invariants');
  });

  it('handles all fields populated', () => {
    const c = makeContract({
      symbol: 'pkg/mod.ts:Fn',
      typeSignature: '() => Promise<void>',
      effectPragma: ['pure', 'async'],
      prohibitedEffects: ['io'],
      mutableInterface: ['cache'],
      immutableInterface: ['token'],
      invariants: ['never leak token'],
      durability: 'persistent',
    });
    const result = formatSingleContract(c);
    expect(result).toContain('### pkg/mod.ts:Fn');
    expect(result).toContain('`() => Promise<void>`');
    expect(result).toContain('persistent');
    expect(result).toContain('pure, async');
    expect(result).toContain('io');
    expect(result).toContain('cache');
    expect(result).toContain('token');
    expect(result).toContain('never leak token');
  });
});

// ---------------------------------------------------------------------------
// formatContractConstitution
// ---------------------------------------------------------------------------

describe.concurrent('formatContractConstitution', () => {
  it('returns empty string for null', () => {
    expect(formatContractConstitution(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatContractConstitution(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(formatContractConstitution([])).toBe('');
  });

  it('includes the header and preamble', () => {
    const result = formatContractConstitution([makeContract()]);
    expect(result).toContain('## Contract (Constitution)');
    expect(result).toContain('You MUST comply with these contracts');
    expect(result).toContain('immutable invariants');
  });

  it('renders multiple contracts', () => {
    const c1 = makeContract({ symbol: 'a.ts:A' });
    const c2 = makeContract({ symbol: 'b.ts:B' });
    const result = formatContractConstitution([c1, c2]);
    expect(result).toContain('### a.ts:A');
    expect(result).toContain('### b.ts:B');
  });

  it('omits optional sections for minimal contracts', () => {
    const result = formatContractConstitution([makeContract()]);
    expect(result).not.toContain('Allowed effects');
    expect(result).not.toContain('Prohibited effects');
    expect(result).not.toContain('Mutable');
    expect(result).not.toContain('Immutable');
    expect(result).not.toContain('Invariants');
  });

  it('includes all sections for fully-populated contracts', () => {
    const c = makeContract({
      effectPragma: ['pure'],
      prohibitedEffects: ['io'],
      mutableInterface: ['x'],
      immutableInterface: ['y'],
      invariants: ['invariant'],
    });
    const result = formatContractConstitution([c]);
    expect(result).toContain('Allowed effects');
    expect(result).toContain('Prohibited effects');
    expect(result).toContain('Mutable');
    expect(result).toContain('Immutable');
    expect(result).toContain('Invariants');
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (fast-check)
// ---------------------------------------------------------------------------

const effectArb = fc.constantFrom<EffectPragma>(
  'pure',
  'io',
  'network',
  'fs-read',
  'fs-write',
  'process-spawn',
  'mutation',
  'async',
);

const contractArb: fc.Arbitrary<AgentContract> = fc.record({
  symbol: fc.string({ minLength: 1, maxLength: 40 }),
  typeSignature: fc.string({ minLength: 1, maxLength: 40 }),
  effectPragma: fc.array(effectArb, { maxLength: 5 }),
  prohibitedEffects: fc.array(effectArb, { maxLength: 5 }),
  mutableInterface: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  immutableInterface: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  invariants: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 5 }),
  durability: fc.constantFrom('transient', 'session', 'persistent'),
});

describe.concurrent('formatSingleContract PBT', () => {
  it('always returns a string containing the symbol', () => {
    fc.assert(
      fc.property(contractArb, (c) => {
        const result = formatSingleContract(c);
        expect(typeof result).toBe('string');
        expect(result).toContain('### ' + c.symbol);
      }),
    );
  });

  it('always contains the type signature', () => {
    fc.assert(
      fc.property(contractArb, (c) => {
        const result = formatSingleContract(c);
        expect(result).toContain('`' + c.typeSignature + '`');
      }),
    );
  });

  it('always contains the durability value', () => {
    fc.assert(
      fc.property(contractArb, (c) => {
        const result = formatSingleContract(c);
        expect(result).toContain(c.durability);
      }),
    );
  });

  it('is total: null and undefined produce empty string', () => {
    expect(formatSingleContract(null)).toBe('');
    expect(formatSingleContract(undefined)).toBe('');
  });
});

describe.concurrent('formatContractConstitution PBT', () => {
  it('is total: null, undefined, and [] produce empty string', () => {
    expect(formatContractConstitution(null)).toBe('');
    expect(formatContractConstitution(undefined)).toBe('');
    expect(formatContractConstitution([])).toBe('');
  });

  it('always starts with the header when non-empty', () => {
    fc.assert(
      fc.property(fc.array(contractArb, { minLength: 1, maxLength: 10 }), (contracts) => {
        const result = formatContractConstitution(contracts);
        expect(result).toContain('## Contract (Constitution)');
      }),
    );
  });

  it('includes every symbol in the output', () => {
    fc.assert(
      fc.property(fc.array(contractArb, { minLength: 1, maxLength: 10 }), (contracts) => {
        const result = formatContractConstitution(contracts);
        for (const c of contracts) {
          expect(result).toContain('### ' + c.symbol);
        }
      }),
    );
  });

  it('output length grows with contract count', () => {
    fc.assert(
      fc.property(
        fc.array(contractArb, { minLength: 1, maxLength: 8 }),
        (contracts) => {
          const result = formatContractConstitution(contracts);
          // Each contract adds at least a header line
          expect(result.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});
