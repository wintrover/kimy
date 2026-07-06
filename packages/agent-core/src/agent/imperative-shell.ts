/**
 * Imperative Shell — the runtime layer that executes effects emitted by the
 * pure core. Side effects happen HERE and ONLY here.
 *
 * Architecture:
 *   1. Pure core produces `AgentEffect[]` — data describing what to do.
 *   2. Shell executes effects via `RuntimeContext` services.
 *   3. Shell feeds results back as `AgentInput` into the pure step function.
 *
 * Design invariants:
 *   - Sequential execution (order matters for determinism).
 *   - Monotonic integer tick counter converts physical events → logical ticks.
 *   - Errors from side effects are caught and converted (never escape to core).
 */

import type {
  AgentEffect,
  AgentInput,
  AgentState,
  PureStepFunction,
  StepResult,
} from '#/agent/core-effect';
import { refinementGuards } from './turn/refinement-guards.js';

// Re-export canonical types for downstream consumers.
export type { AgentPhaseState, AgentState, AgentEffect, AgentInput, PureStepFunction, StepResult } from '#/agent/core-effect';

// ─── RuntimeContext ──────────────────────────────────────────────────────────

/** The runtime context — all mutable, effect-ful services the Shell needs. */
export interface RuntimeContext {
  readonly agent: {
    emitStatusUpdated: () => void
    records: { logRecord: (record: unknown) => void }
    rpc?: { sendEvent: (event: string, payload: unknown) => void }
  }
  readonly executeTool: (name: string, args: unknown) => Promise<unknown>
  readonly generate: (messages: unknown[], config: unknown) => Promise<unknown>
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly sleep: (ms: number) => Promise<void>
}

// ─── Tick Counter ────────────────────────────────────────────────────────────

/** Creates a monotonic tick counter. Physical time → logical tick conversion. */
export function createTickCounter(initialTick: number = 0): {
  next: () => number
  current: () => number
} {
  let tick = initialTick
  return {
    next: () => ++tick,
    current: () => tick,
  }
}

// ─── Effect Execution ────────────────────────────────────────────────────────

/**
 * Execute a single AgentEffect and return the resulting AgentInput.
 * This is the ONLY place where side effects happen.
 * Returns null for fire-and-forget effects (no input to feed back).
 */
export async function executeEffect(
  effect: AgentEffect,
  ctx: RuntimeContext,
  tickCounter: { next: () => number },
): Promise<AgentInput | null> {
  const logicalTick = tickCounter.next()

  // Refinement guard: validate the effect is well-formed before execution.
  // A malformed or unknown effect type is silently dropped (Principle A: total).
  if (!('type' in effect) || typeof (effect as AgentEffect).type !== 'string') {
    return null
  }

  try {
    switch (effect.type) {
      case 'EMIT_STATUS':
        ctx.agent.emitStatusUpdated()
        return null

      case 'LOG_RECORD':
        ctx.agent.records.logRecord(effect.record)
        return null

      case 'SEND_EVENT':
        ctx.agent.rpc?.sendEvent(effect.event, effect.payload)
        return null

      case 'CALL_TOOL': {
        const result = await ctx.executeTool(effect.toolName, effect.args)
        return { type: 'TOOL_RESULT', toolName: effect.toolName, result, logicalTick }
      }

      case 'LLM_REQUEST': {
        const response = await ctx.generate([...effect.messages], effect.config)
        return { type: 'LLM_RESPONSE', response, logicalTick }
      }

      case 'SCHEDULE_RETRY':
        await ctx.sleep(effect.delayMs)
        return null

      case 'READ_FILE': {
        const content = await ctx.readFile(effect.path)
        return { type: 'TOOL_RESULT', toolName: 'read_file', result: content, logicalTick }
      }

      case 'WRITE_FILE':
        await ctx.writeFile(effect.path, effect.content)
        return null

      // Turn / compaction effects — no runtime action in the shell
      case 'BEGIN_TURN':
      case 'END_TURN':
      case 'RESET_TO_PLANNING':
      case 'APPEND_MESSAGE':
      case 'COMPACTION_COMPLETE':
        return null
    }
  } catch {
    // Errors from side effects are caught and converted — never escape to core.
    return null
  }
}

/**
 * Execute a sequence of effects and collect resulting inputs.
 * Effects are executed sequentially (order matters for determinism).
 */
export async function executeEffects(
  effects: readonly AgentEffect[],
  ctx: RuntimeContext,
  tickCounter: { next: () => number },
): Promise<readonly AgentInput[]> {
  const inputs: AgentInput[] = []

  for (const effect of effects) {
    const input = await executeEffect(effect, ctx, tickCounter)
    if (input !== null) {
      inputs.push(input)
    }
  }

  return inputs
}

// ─── Run Loop ────────────────────────────────────────────────────────────────

/**
 * The main loop: apply pure step function, execute effects, feed results back.
 * This is the complete Imperative Shell loop.
 *
 * @param initialState  - The starting state for the agent
 * @param step          - Pure step function: (state, input) → { state, effects }
 * @param ctx           - Runtime context with side-effect services
 * @param externalInputs - Async iterable of external inputs (user messages, etc.)
 * @param maxIterations - Safety limit to prevent infinite loops
 * @returns The final agent state after all inputs are processed
 */
export async function runLoop(
  initialState: AgentState,
  step: PureStepFunction,
  ctx: RuntimeContext,
  externalInputs: AsyncIterable<AgentInput>,
  maxIterations: number = 1000,
): Promise<AgentState> {
  let state = initialState
  const tickCounter = createTickCounter(state.logicalTick)
  let iterations = 0

  for await (const externalInput of externalInputs) {
    if (iterations++ >= maxIterations) break

    // 1. Apply pure step function
    const result = step(state, externalInput)

    // 2. Update state (immutable replacement)
    state = result.state

    // 3. Execute effects in the shell
    const internalInputs = await executeEffects(result.effects, ctx, tickCounter)

    // 4. Refinement guard: validate state invariants after each iteration
    if (!refinementGuards.checkTickMonotonicity(state, tickCounter.current())) {
      // Tick drift detected — state may be stale. Continue but log.
      ctx.agent.records.logRecord({ type: 'guard.tick_drift', tick: state.logicalTick })
    }

    // 5. Feed internal results back through the step function
    for (const internalInput of internalInputs) {
      if (iterations++ >= maxIterations) break

      const innerResult = step(state, internalInput)
      state = innerResult.state

      // Execute any nested effects (1 level deep for safety)
      if (innerResult.effects.length > 0) {
        await executeEffects(innerResult.effects, ctx, tickCounter)
        // Nested inputs are NOT fed back (prevents infinite loops)
      }
    }
  }

  return state
}
