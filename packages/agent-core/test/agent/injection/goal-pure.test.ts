import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { GoalBudgetReport, GoalSnapshot } from '../../../src/agent/goal';
import {
  buildBlockedNote,
  buildGoalReminder,
  buildPausedNote,
  budgetBandGuidance,
  escapeUntrustedText,
  formatElapsed,
  maxBudgetFraction,
} from '../../../src/agent/injection/goal-pure';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function budget(overrides?: Partial<GoalBudgetReport>): GoalBudgetReport {
  return {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
    ...overrides,
  } as GoalBudgetReport;
}

function makeSnapshot(overrides?: Omit<Partial<GoalSnapshot>, 'budget'> & { budget?: Partial<GoalBudgetReport> }): GoalSnapshot {
  const { budget: budgetOverrides, ...rest } = overrides ?? {};
  return {
    goalId: 'g1',
    objective: 'Ship feature X',
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: budget(budgetOverrides),
    ...rest,
  };
}

// ===========================================================================
// escapeUntrustedText
// ===========================================================================

describe.concurrent('escapeUntrustedText', () => {
  it('returns empty string for null', () => {
    expect(escapeUntrustedText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeUntrustedText(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(escapeUntrustedText('')).toBe('');
  });

  it('escapes ampersands', () => {
    expect(escapeUntrustedText('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeUntrustedText('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes all three characters in one string', () => {
    expect(escapeUntrustedText('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
  });

  it('preserves text with no special characters', () => {
    expect(escapeUntrustedText('hello world')).toBe('hello world');
  });

  it('handles very long strings', () => {
    const long = 'x'.repeat(10_000);
    expect(escapeUntrustedText(long)).toBe(long);
  });

  it('never throws on arbitrary input (PBT)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => escapeUntrustedText(s)).not.toThrow();
        expect(typeof escapeUntrustedText(s)).toBe('string');
      }),
    );
  });

  it('result never contains raw unescaped < or > when input has them (PBT)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (s) => {
          const escaped = escapeUntrustedText(s);
          if (s.includes('<')) expect(escaped).toContain('&lt;');
          if (s.includes('>')) expect(escaped).toContain('&gt;');
          if (s.includes('&')) expect(escaped).toContain('&amp;');
        },
      ),
    );
  });
});

// ===========================================================================
// formatElapsed
// ===========================================================================

describe.concurrent('formatElapsed', () => {
  it('returns "0s" for null', () => {
    expect(formatElapsed(null)).toBe('0s');
  });

  it('returns "0s" for undefined', () => {
    expect(formatElapsed(undefined)).toBe('0s');
  });

  it('returns "0s" for 0 ms', () => {
    expect(formatElapsed(0)).toBe('0s');
  });

  it('formats sub-minute durations in seconds', () => {
    expect(formatElapsed(42_000)).toBe('42s');
  });

  it('rounds to the nearest second', () => {
    expect(formatElapsed(1500)).toBe('2s');
  });

  it('formats durations >= 1 minute with minutes and seconds', () => {
    expect(formatElapsed(90_000)).toBe('1m30s');
  });

  it('pads single-digit seconds', () => {
    expect(formatElapsed(61_000)).toBe('1m01s');
  });

  it('formats exact minutes with "00s"', () => {
    expect(formatElapsed(120_000)).toBe('2m00s');
  });

  it('handles very large values', () => {
    expect(formatElapsed(3_661_000)).toBe('61m01s');
  });

  it('never throws on arbitrary numeric input (PBT)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), fc.double({ min: 0, noNaN: true })),
        (ms) => {
          expect(() => formatElapsed(ms)).not.toThrow();
          expect(typeof formatElapsed(ms)).toBe('string');
        },
      ),
    );
  });

  it('result always matches /^\\d+m\\d{2}s$|^\\d+s$/', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: 0, max: 10_000_000 }), fc.double({ min: 0, max: 10_000_000, noNaN: true })),
        (ms) => {
          const result = formatElapsed(ms);
          const isShort = /^\d+s$/.test(result);
          const isLong = /^\d+m\d{2}s$/.test(result);
          expect(isShort || isLong).toBe(true);
        },
      ),
    );
  });
});

// ===========================================================================
// maxBudgetFraction
// ===========================================================================

describe.concurrent('maxBudgetFraction', () => {
  it('returns 0 for null', () => {
    expect(maxBudgetFraction(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(maxBudgetFraction(undefined)).toBe(0);
  });

  it('returns 0 when no budgets are set', () => {
    expect(maxBudgetFraction(makeSnapshot())).toBe(0);
  });

  it('computes turn fraction correctly', () => {
    const snap = makeSnapshot({ turnsUsed: 3, budget: { turnBudget: 10, remainingTurns: 7 } });
    expect(maxBudgetFraction(snap)).toBe(120); // 3/10 = 30% → 30 * 400 / 100 = 120
  });

  it('computes token fraction correctly', () => {
    const snap = makeSnapshot({ tokensUsed: 500, budget: { tokenBudget: 1000, remainingTokens: 500 } });
    expect(maxBudgetFraction(snap)).toBe(200); // 500/1000 = 50% → 50 * 400 / 100 = 200
  });

  it('returns the max across multiple budgets', () => {
    const snap = makeSnapshot({
      turnsUsed: 3,
      tokensUsed: 900,
      budget: { turnBudget: 10, remainingTurns: 7, tokenBudget: 1000, remainingTokens: 100 },
    });
    expect(maxBudgetFraction(snap)).toBe(360); // max(120, 360) = 360 (90%)
  });

  it('ignores zero-value budgets (division guard)', () => {
    const snap = makeSnapshot({ turnsUsed: 5, budget: { turnBudget: 0, remainingTurns: 0 } });
    expect(maxBudgetFraction(snap)).toBe(0);
  });

  it('ignores negative budgets', () => {
    const snap = makeSnapshot({ turnsUsed: 5, budget: { turnBudget: -1, remainingTurns: -6 } });
    expect(maxBudgetFraction(snap)).toBe(0);
  });

  it('computes wall clock fraction correctly', () => {
    const snap = makeSnapshot({
      wallClockMs: 30_000,
      budget: { wallClockBudgetMs: 60_000, remainingWallClockMs: 30_000 },
    });
    expect(maxBudgetFraction(snap)).toBe(200); // 30000/60000 = 50% → 200
  });
});

// ===========================================================================
// budgetBandGuidance
// ===========================================================================

describe.concurrent('budgetBandGuidance', () => {
  it('returns within-budget string when no budgets set (fraction = 0)', () => {
    expect(budgetBandGuidance(makeSnapshot())).toContain('within budget');
  });

  it('returns within-budget string below 75%', () => {
    const snap = makeSnapshot({ turnsUsed: 7, budget: { turnBudget: 10, remainingTurns: 3 } });
    expect(budgetBandGuidance(snap)).toContain('within budget');
  });

  it('returns convergence string at exactly 75%', () => {
    const snap = makeSnapshot({ turnsUsed: 3, budget: { turnBudget: 4, remainingTurns: 1 } });
    expect(budgetBandGuidance(snap)).toContain('nearing a budget');
  });

  it('returns convergence string above 75%', () => {
    const snap = makeSnapshot({ turnsUsed: 9, budget: { turnBudget: 10, remainingTurns: 1 } });
    expect(budgetBandGuidance(snap)).toContain('nearing a budget');
  });

  it('returns within-budget for null input', () => {
    expect(budgetBandGuidance(null)).toContain('within budget');
  });

  it('returns within-budget for undefined input', () => {
    expect(budgetBandGuidance(undefined)).toContain('within budget');
  });
});

// ===========================================================================
// buildBlockedNote
// ===========================================================================

describe.concurrent('buildBlockedNote', () => {
  it('returns empty string for null', () => {
    expect(buildBlockedNote(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(buildBlockedNote(undefined)).toBe('');
  });

  it('contains "currently blocked"', () => {
    expect(buildBlockedNote(makeSnapshot({ status: 'blocked' }))).toContain('currently blocked');
  });

  it('includes terminalReason in parentheses when present', () => {
    const result = buildBlockedNote(makeSnapshot({ status: 'blocked', terminalReason: 'rate limit' }));
    expect(result).toContain('(rate limit)');
  });

  it('omits parenthetical when no terminalReason', () => {
    expect(buildBlockedNote(makeSnapshot({ status: 'blocked' }))).not.toMatch(/blocked \(/);
  });

  it('wraps objective in <untrusted_objective>', () => {
    const result = buildBlockedNote(makeSnapshot({ status: 'blocked', objective: 'do stuff' }));
    expect(result).toContain('<untrusted_objective>\ndo stuff\n</untrusted_objective>');
  });

  it('includes completion criterion when present', () => {
    const result = buildBlockedNote(
      makeSnapshot({ status: 'blocked', objective: 'work', completionCriterion: 'tests pass' }),
    );
    expect(result).toContain('<untrusted_completion_criterion>\ntests pass\n</untrusted_completion_criterion>');
  });

  it('omits completion criterion wrapper when absent', () => {
    expect(buildBlockedNote(makeSnapshot({ status: 'blocked' }))).not.toContain('untrusted_completion_criterion');
  });

  it('mentions /goal resume', () => {
    expect(buildBlockedNote(makeSnapshot({ status: 'blocked' }))).toContain('/goal resume');
  });

  it('escapes HTML-like objective text', () => {
    const result = buildBlockedNote(makeSnapshot({ status: 'blocked', objective: '<script>x</script>' }));
    expect(result).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

// ===========================================================================
// buildPausedNote
// ===========================================================================

describe.concurrent('buildPausedNote', () => {
  it('returns empty string for null', () => {
    expect(buildPausedNote(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(buildPausedNote(undefined)).toBe('');
  });

  it('contains "currently paused"', () => {
    expect(buildPausedNote(makeSnapshot({ status: 'paused' }))).toContain('currently paused');
  });

  it('includes terminalReason when present', () => {
    const result = buildPausedNote(makeSnapshot({ status: 'paused', terminalReason: 'user request' }));
    expect(result).toContain('(user request)');
  });

  it('omits parenthetical when no terminalReason', () => {
    expect(buildPausedNote(makeSnapshot({ status: 'paused' }))).not.toMatch(/paused \(/);
  });

  it('wraps objective in <untrusted_objective>', () => {
    const result = buildPausedNote(makeSnapshot({ status: 'paused', objective: 'fix bugs' }));
    expect(result).toContain('<untrusted_objective>\nfix bugs\n</untrusted_objective>');
  });

  it('mentions "Do not work on it unless the user explicitly asks"', () => {
    expect(buildPausedNote(makeSnapshot({ status: 'paused' }))).toContain('Do not work on it unless the user explicitly asks');
  });

  it('mentions UpdateGoal with `active`', () => {
    expect(buildPausedNote(makeSnapshot({ status: 'paused' }))).toContain('UpdateGoal with `active`');
  });
});

// ===========================================================================
// buildGoalReminder
// ===========================================================================

describe.concurrent('buildGoalReminder', () => {
  it('returns empty string for null', () => {
    expect(buildGoalReminder(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(buildGoalReminder(undefined)).toBe('');
  });

  it('contains the opening line', () => {
    expect(buildGoalReminder(makeSnapshot())).toContain('You are working under an active goal (goal mode).');
  });

  it('wraps the objective', () => {
    const result = buildGoalReminder(makeSnapshot({ objective: 'Ship feature X' }));
    expect(result).toContain('<untrusted_objective>\nShip feature X\n</untrusted_objective>');
  });

  it('includes completion criterion when present', () => {
    const result = buildGoalReminder(makeSnapshot({ objective: 'work', completionCriterion: 'tests pass' }));
    expect(result).toContain('<untrusted_completion_criterion>\ntests pass\n</untrusted_completion_criterion>');
  });

  it('omits completion criterion when absent', () => {
    expect(buildGoalReminder(makeSnapshot())).not.toContain('untrusted_completion_criterion');
  });

  it('includes status', () => {
    expect(buildGoalReminder(makeSnapshot({ status: 'active' }))).toContain('Status: active');
  });

  it('includes turn/token/wall-clock progress', () => {
    const result = buildGoalReminder(makeSnapshot({ turnsUsed: 5, tokensUsed: 1000, wallClockMs: 30_000 }));
    expect(result).toContain('5 continuation turns');
    expect(result).toContain('1000 tokens');
    expect(result).toContain('30s elapsed');
  });

  it('includes turn budget when set', () => {
    const snap = makeSnapshot({ turnsUsed: 2, budget: { turnBudget: 10, remainingTurns: 8 } });
    const result = buildGoalReminder(snap);
    expect(result).toContain('Budgets:');
    expect(result).toContain('turns 2/10 (remaining 8)');
  });

  it('includes token budget when set', () => {
    const snap = makeSnapshot({ tokensUsed: 500, budget: { tokenBudget: 2000, remainingTokens: 1500 } });
    const result = buildGoalReminder(snap);
    expect(result).toContain('tokens 500/2000 (remaining 1500)');
  });

  it('includes wall-clock budget when set', () => {
    const snap = makeSnapshot({
      wallClockMs: 60_000,
      budget: { wallClockBudgetMs: 120_000, remainingWallClockMs: 60_000 },
    });
    const result = buildGoalReminder(snap);
    expect(result).toContain('time 1m00s/2m00s (remaining 1m00s)');
  });

  it('omits Budgets line when no budgets set', () => {
    expect(buildGoalReminder(makeSnapshot())).not.toContain('Budgets:');
  });

  it('includes convergence band near budget', () => {
    const snap = makeSnapshot({ turnsUsed: 3, budget: { turnBudget: 4, remainingTurns: 1 } });
    expect(buildGoalReminder(snap)).toContain('nearing a budget');
  });

  it('includes within-budget band', () => {
    const snap = makeSnapshot({ turnsUsed: 1, budget: { turnBudget: 10, remainingTurns: 9 } });
    expect(buildGoalReminder(snap)).toContain('within budget');
  });

  it('includes SetGoalBudget guidance', () => {
    expect(buildGoalReminder(makeSnapshot())).toContain('SetGoalBudget');
  });

  it('includes UpdateGoal guidance', () => {
    expect(buildGoalReminder(makeSnapshot())).toContain('UpdateGoal');
  });

  it('includes iterative mode guidance', () => {
    expect(buildGoalReminder(makeSnapshot())).toContain('Goal mode is iterative');
  });

  it('never throws on arbitrary GoalSnapshot-like data (PBT)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 100_000 }),
        fc.nat({ max: 10_000_000 }),
        (objective, turnsUsed, tokensUsed, wallClockMs) => {
          const snap = makeSnapshot({ objective, turnsUsed, tokensUsed, wallClockMs });
          expect(() => buildGoalReminder(snap)).not.toThrow();
          expect(typeof buildGoalReminder(snap)).toBe('string');
        },
      ),
    );
  });
});
