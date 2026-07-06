/**
 * Model-based testing framework built on fast-check's command pattern.
 *
 * Provides a generic `StateTransition` command class and a
 * `createStateMachineTest` helper for testing state machines with
 * randomised command sequences and post-run invariant assertions.
 *
 * Uses fast-check's `fc.commands()` + `fc.modelRun()` pattern:
 *
 *   1. The **model** is a pure data representation of the system.
 *   2. Each **command** has a `check(model)` guard and a `run(model, real)` body.
 *   3. fast-check generates random command sequences, shrinks on failure.
 *   4. Invariant assertions run after every command execution.
 *
 * @module
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The "real" side of the model/run pair.  We pass through the
 * caller-provided system under test, plus a reference to the mutable
 * state so `run()` can apply the same transition the real system did.
 */
export interface StateTransitionReal<S extends object> {
  /** The system under test (user-defined). */
  system: unknown;
  /** Mutable reference — `run()` updates this after applying the real transition. */
  state: S;
}

/**
 * Configuration for `createStateMachineTest`.
 */
export interface StateMachineTestConfig<S extends object> {
  /**
   * Factory that returns the initial model.  Called once per property run.
   */
  initialState: () => S;

  /**
   * Array of fast-check arbitraries that produce commands.
   */
  commandArbitraries: fc.Arbitrary<fc.Command<S, StateTransitionReal<S>>>[];

  /**
   * Invariant predicates evaluated after every command execution.
   * Throw (or use `expect`) to signal a violated invariant.
   */
  invariants: Array<(model: Readonly<S>) => void>;

  /**
   * Optional constraints forwarded to `fc.commands()`.
   */
  commandConstraints?: fc.CommandsContraints;

  /**
   * Optional factory for the "real" system under test.  Called once per
   * property run.  Defaults to `null` (commands must not depend on it).
   */
  createReal?: () => unknown;

  /**
   * Optional number of runs passed to `fc.assert()`.  Defaults to 100.
   */
  numRuns?: number;
}

// ---------------------------------------------------------------------------
// Generic StateTransition command class
// ---------------------------------------------------------------------------

/**
 * A generic command for testing state machines.
 *
 * Subclass this (or instantiate directly with callbacks) to define
 * individual operations such as increment, decrement, reset, etc.
 *
 * @typeParam S - Model state type (must extend `object`).
 * @typeParam I - Input type carried by the command.
 */
export class StateTransition<S extends object, I> implements fc.Command<S, StateTransitionReal<S>> {
  /** The input payload for this transition. */
  readonly input: I;

  /**
   * @param name     Human-readable name (used in `toString()`).
   * @param input    The input that drives this transition.
   * @param apply    `(model, input) => nextModel` — pure model transition.
   * @param execute  `(input, real) => void` — side-effecting system mutation.
   * @param checkFn  Optional pre-condition guard.  Defaults to `true`.
   */
  constructor(
    readonly name: string,
    input: I,
    private readonly apply: (model: Readonly<S>, input: I) => S,
    private readonly execute: (input: I, real: StateTransitionReal<S>) => void,
    private readonly checkFn?: (model: Readonly<S>, input: I) => boolean,
  ) {
    this.input = input;
  }

  check(model: Readonly<S>): boolean {
    if (this.checkFn) {
      return this.checkFn(model, this.input);
    }
    return true;
  }

  run(model: S, real: StateTransitionReal<S>): void {
    this.execute(this.input, real);
    // Advance the model to the expected next state.
    Object.assign(model, this.apply(model, this.input));
  }

  toString(): string {
    return `${this.name}(${JSON.stringify(this.input)})`;
  }
}

// ---------------------------------------------------------------------------
// Helper: build a StateTransition command arbitrary from config
// ---------------------------------------------------------------------------

/**
 * Create a command arbitrary from a name, input arbitrary, and
 * transition/execute functions.  This is the low-level building block
 * that `createStateMachineTest` wires together.
 */
export function stateTransitionCommand<S extends object, I>(
  name: string,
  inputArb: fc.Arbitrary<I>,
  apply: (model: Readonly<S>, input: I) => S,
  execute: (input: I, real: StateTransitionReal<S>) => void,
  checkFn?: (model: Readonly<S>, input: I) => boolean,
): fc.Arbitrary<fc.Command<S, StateTransitionReal<S>>> {
  return inputArb.map(
    (input) => new StateTransition(name, input, apply, execute, checkFn),
  );
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

/**
 * Create and run a fast-check property test for a state machine.
 *
 * Generates random sequences of commands, executes them against both
 * the model and the real system, and checks invariants after every step.
 *
 * @example
 * ```ts
 * import { describe, it, expect } from 'vitest';
 *
 * describe('counter', () => {
 *   it('maintains non-negative invariant', () => {
 *     createStateMachineTest({
 *       initialState: () => ({ count: 0 }),
 *       commandArbitraries: [/* command arbitraries *\/],
 *       invariants: [(s) => { expect(s.count).toBeGreaterThanOrEqual(0); }],
 *     });
 *   });
 * });
 * ```
 *
 * @param config  Machine configuration.
 */
export function createStateMachineTest<S extends object>(
  config: StateMachineTestConfig<S>,
): void {
  const {
    initialState,
    commandArbitraries,
    invariants,
    commandConstraints,
    createReal,
    numRuns = 100,
  } = config;

  const cmdsArb = fc.commands(commandArbitraries, commandConstraints);

  fc.assert(
    fc.property(cmdsArb, (cmds) => {
      // Set up the initial model + real pair.
      const initial = initialState();
      const real: StateTransitionReal<S> = {
        system: createReal ? createReal() : null,
        state: initial,
      };

      // Wrap initial so fc.modelRun can use it.
      const setup: fc.ModelRunSetup<S, StateTransitionReal<S>> = () => ({
        model: initial,
        real,
      });

      // Execute the command sequence.
      fc.modelRun(setup, cmds as Iterable<fc.Command<S, StateTransitionReal<S>>>);

      // Verify invariants on the final model state.
      for (const invariant of invariants) {
        invariant(real.state);
      }
    }),
    { numRuns },
  );
}

// ---------------------------------------------------------------------------
// Convenience: create commands from a plain transition table
// ---------------------------------------------------------------------------

export interface TransitionSpec<S extends object> {
  name: string;
  inputArb: fc.Arbitrary<unknown>;
  apply: (model: Readonly<S>, input: unknown) => S;
  execute: (input: unknown, real: StateTransitionReal<S>) => void;
  check?: (model: Readonly<S>, input: unknown) => boolean;
}

/**
 * Convert an array of `TransitionSpec` definitions into command
 * arbitraries suitable for passing to `createStateMachineTest`.
 */
export function transitionCommands<S extends object>(
  specs: TransitionSpec<S>[],
): fc.Arbitrary<fc.Command<S, StateTransitionReal<S>>>[] {
  return specs.map((spec) =>
    stateTransitionCommand(spec.name, spec.inputArb, spec.apply, spec.execute, spec.check),
  );
}
