import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  type StateTransitionReal,
  StateTransition,
  stateTransitionCommand,
  createStateMachineTest,
  transitionCommands,
  type TransitionSpec,
} from './model-based-testing';

// ---------------------------------------------------------------------------
// System under test: a simple non-negative counter
// ---------------------------------------------------------------------------

class NonNegativeCounter {
  private _value = 0;

  get value(): number {
    return this._value;
  }

  inc(by = 1): void {
    this._value += by;
  }

  dec(by = 1): void {
    this._value -= by;
  }

  reset(): void {
    this._value = 0;
  }
}

// ---------------------------------------------------------------------------
// Model type
// ---------------------------------------------------------------------------

interface CounterModel {
  count: number;
}

// ---------------------------------------------------------------------------
// Specs for counter operations
// ---------------------------------------------------------------------------

function counterTransitionSpecs(): TransitionSpec<CounterModel>[] {
  const safeIncSpec: TransitionSpec<CounterModel> = {
    name: 'inc',
    inputArb: fc.record({ by: fc.integer({ min: 1, max: 100 }) }),
    apply: (m, input) => {
      const { by } = input as { by: number };
      return { count: m.count + by };
    },
    execute: (input, real) => {
      const { by } = input as { by: number };
      (real.system as NonNegativeCounter).inc(by);
    },
  };

  const safeDecSpec: TransitionSpec<CounterModel> = {
    name: 'dec',
    inputArb: fc.record({ by: fc.integer({ min: 1, max: 100 }) }),
    apply: (m, input) => {
      const { by } = input as { by: number };
      return { count: m.count - by };
    },
    execute: (input, real) => {
      const { by } = input as { by: number };
      (real.system as NonNegativeCounter).dec(by);
    },
    check: (m, input) => {
      const { by } = input as { by: number };
      return m.count >= by;
    },
  };

  const resetSpec: TransitionSpec<CounterModel> = {
    name: 'reset',
    inputArb: fc.constant({}),
    apply: () => ({ count: 0 }),
    execute: (_input, real) => {
      (real.system as NonNegativeCounter).reset();
    },
  };

  return [safeIncSpec, safeDecSpec, resetSpec];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.concurrent('model-based-testing', () => {
  describe.concurrent('StateTransition command class', () => {
    it('check() returns true when no guard is provided', () => {
      const cmd = new StateTransition<CounterModel, {}>(
        'noop',
        {},
        (m) => m,
        () => {},
      );
      expect(cmd.check({ count: 0 })).toBe(true);
    });

    it('check() delegates to the guard function', () => {
      const cmd = new StateTransition<CounterModel, {}>(
        'noop',
        {},
        (m) => m,
        () => {},
        (m) => m.count > 5,
      );
      expect(cmd.check({ count: 0 })).toBe(false);
      expect(cmd.check({ count: 10 })).toBe(true);
    });

    it('run() advances the model via apply and delegates to execute', () => {
      const calls: Array<{ model: CounterModel; input: unknown }> = [];
      const applyFn = vi.fn((m: CounterModel) => {
        // Capture pre-mutation state before Object.assign overwrites it.
        calls.push({ model: { count: m.count }, input: undefined });
        return { count: m.count + 1 };
      });
      const execFn = vi.fn();
      const cmd = new StateTransition<CounterModel, {}>(
        'inc',
        {},
        applyFn,
        execFn,
      );

      const model: CounterModel = { count: 0 };
      const real: StateTransitionReal<CounterModel> = {
        system: null,
        state: model,
      };

      cmd.run(model, real);

      expect(applyFn).toHaveBeenCalledTimes(1);
      // The mock was called with the original model reference (count=0).
      expect(calls[0]!.model.count).toBe(0);
      expect(execFn).toHaveBeenCalledWith({}, real);
      // Model should have been mutated via Object.assign inside run().
      expect(model.count).toBe(1);
    });

    it('toString() includes name and JSON-serialised input', () => {
      const cmd = new StateTransition<CounterModel, { n: number }>(
        'add',
        { n: 42 },
        (m, i) => ({ count: m.count + i.n }),
        () => {},
      );
      expect(cmd.toString()).toBe('add({"n":42})');
    });
  });

  describe.concurrent('stateTransitionCommand()', () => {
    it('produces a command arbitrary whose check delegates to the guard', () => {
      const arb = stateTransitionCommand<CounterModel, { by: number }>(
        'dec',
        fc.record({ by: fc.integer({ min: 1, max: 5 }) }),
        (m, i) => ({ count: m.count - i.by }),
        () => {},
        (m, i) => m.count >= i.by,
      );

      // Generate a concrete command and verify check() works.
      const cmd = fc.sample(arb, { numRuns: 1 })[0]!;
      expect(cmd).toBeInstanceOf(StateTransition);
      expect((cmd as StateTransition<CounterModel, { by: number }>).name).toBe('dec');
      expect(cmd.check({ count: 0 })).toBe(false);
      expect(cmd.check({ count: 100 })).toBe(true);
    });
  });

  describe.concurrent('transitionCommands()', () => {
    it('converts a spec array into command arbitraries', () => {
      const specs = counterTransitionSpecs();
      const arbs = transitionCommands(specs);

      expect(arbs).toHaveLength(3);

      for (const arb of arbs) {
        const samples = fc.sample(arb, { numRuns: 5 });
        for (const cmd of samples) {
          expect(typeof cmd.toString()).toBe('string');
          expect(typeof cmd.check({ count: 0 })).toBe('boolean');
        }
      }
    });
  });

  describe.concurrent('createStateMachineTest()', () => {
    it('counter: increment and decrement maintain non-negative invariant', () => {
      const specs = counterTransitionSpecs();
      const commandArbitraries = transitionCommands(specs);

      createStateMachineTest<CounterModel>({
        initialState: () => ({ count: 0 }),
        createReal: () => new NonNegativeCounter(),
        commandArbitraries,
        invariants: [
          (m) => {
            expect(m.count).toBeGreaterThanOrEqual(0);
          },
        ],
        numRuns: 200,
      });
    });

    it('counter: model and real stay in sync', () => {
      const specs = counterTransitionSpecs();
      const commandArbitraries = transitionCommands(specs);

      fc.assert(
        fc.property(fc.commands(commandArbitraries), (cmds) => {
          const counter = new NonNegativeCounter();
          const model: CounterModel = { count: 0 };
          const real: StateTransitionReal<CounterModel> = {
            system: counter,
            state: model,
          };

          fc.modelRun(() => ({ model, real }), cmds);

          // After all commands, model and real must agree.
          expect(model.count).toBe(counter.value);
        }),
        { numRuns: 200 },
      );
    });

    it('commands that violate preconditions are skipped by fast-check', () => {
      // If we add a risky "dec by 1000" command that is only guarded
      // when count >= 1000, fast-check should never actually run it.
      const riskyDecArb = stateTransitionCommand<CounterModel, {}>(
        'risky-dec',
        fc.constant({}),
        (m) => ({ count: m.count - 1000 }),
        () => {},
        (m) => m.count >= 1000,
      );

      const incArb = stateTransitionCommand<CounterModel, { by: number }>(
        'inc',
        fc.record({ by: fc.integer({ min: 1, max: 50 }) }),
        (m, i) => ({ count: m.count + i.by }),
        () => {},
      );

      createStateMachineTest<CounterModel>({
        initialState: () => ({ count: 0 }),
        commandArbitraries: [riskyDecArb, incArb],
        invariants: [
          (m) => {
            expect(m.count).toBeGreaterThanOrEqual(0);
          },
        ],
        numRuns: 100,
      });
    });
  });
});
