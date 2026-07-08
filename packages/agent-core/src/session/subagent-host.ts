import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { ErrorCodes, type KimiErrorPayload } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import { createChildLLM } from './llm-factory';
import { ProviderCircuitBreaker } from './provider-circuit-breaker';
import { resolveModel, createCircuitSnapshot, createRoutingSnapshot } from './model-router';
import type { AgentContext } from '#/config/agent-context';
import type { Session } from './index';
import {
  SubagentBatch,
  resolveSwarmMaxConcurrency,
  type BatchExecutionContext,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const ORCHESTRATION_TOOLS = new Set(['AgentSwarm']);
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export type ProvisioningPreconditionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Contract data injected into a subagent's system prompt during configuration.
 * Defines the subagent's task scope, expected behavior, and context boundaries
 * so the child agent has deterministic knowledge of its role in the swarm.
 */
export interface SubagentContract {
  /** The task description / prompt for this subagent */
  readonly task: string;
  /** The specific swarm item this subagent is responsible for */
  readonly item?: string;
  /** The subagent's role/profile name */
  readonly role: string;
  /** Swarm index for ordering context */
  readonly index?: number;
}

/**
 * Build a subagent contract from spawn options.
 * The contract captures the deterministic task specification that will be
 * injected into the child's context before any user-provided prompt content.
 */
function buildSubagentContract(options: SpawnSubagentOptions): SubagentContract {
  return {
    task: options.description,
    item: options.swarmItem,
    role: options.profileName,
    index: options.swarmIndex,
  };
}

/**
 * Render a subagent contract as a structured system reminder.
 * Uses XML-like tags for clear machine-readable boundaries while remaining
 * human-readable in context windows.
 */
function renderContractAsReminder(contract: SubagentContract): string {
  const lines = [
    `<subagent_contract>`,
    `<role>${contract.role}</role>`,
    `<task>${contract.task}</task>`,
  ];
  if (contract.item !== undefined) {
    lines.push(`<item>${contract.item}</item>`);
  }
  if (contract.index !== undefined) {
    lines.push(`<index>${String(contract.index)}</index>`);
  }
  lines.push(`</subagent_contract>`);
  return lines.join('\n');
}

export class SessionSubagentHost {
  private _runtimeSubagentModel: string | null = null;
  private readonly circuitBreaker = new ProviderCircuitBreaker();
  private readonly activeChildren = new Map<
    string,
    {
      readonly controller: AbortController;
      runInBackground: boolean;
    }
  >();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    readonly agentContext?: AgentContext,
  ) {}

  /**
   * Runtime override for the subagent model.
   * `null` means "no override, fall through to config/parent".
   * A non-empty string forces that model alias for all child agents.
   */
  public setRuntimeSubagentModel(model: string | null): void {
    this._runtimeSubagentModel = model;
  }

  /** Record a successful provider call for circuit breaker tracking */
  public recordProviderSuccess(providerId: string): void {
    this.circuitBreaker.recordSuccess(providerId);
  }

  /** Record a failed provider call for circuit breaker tracking */
  public recordProviderFailure(providerId: string): void {
    this.circuitBreaker.recordFailure(providerId);
  }

  async spawn(options: SpawnSubagentOptions, context?: BatchExecutionContext): Promise<SubagentHandle> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);

    // Validate ALL preconditions before creating the agent to prevent
    // 'born dead' agents — agents created but never receiving an LLM call.
    const precondition = await this.validateProvisioningPreconditions(
      parent,
      options.profileName,
      options.signal,
      context,
    );
    if (!precondition.ok) {
      this.session.log.warn('subagent_provisioning_blocked', {
        reason: precondition.reason,
        profileName: options.profileName,
      });
      throw new Error(`Subagent provisioning blocked: ${precondition.reason}`);
    }

    const profile = this.resolveProfile(parent, options.profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem },
    );
    try {
      const contract = buildSubagentContract(options);
      const completion = this.runWithActiveChild(id, options, async (runOptions) => {
        this.emitSubagentSpawned(parent, id, profile.name, runOptions);
        try {
          await this.configureChild(parent, agent, profile, context, contract);
          return await this.runPromptTurn(parent, id, agent, profile.name, runOptions, context);
        } catch (error) {
          this.emitSubagentFailed(parent, id, runOptions, error);
          throw error;
        }
      });
      return {
        agentId: id,
        profileName: profile.name,
        resumed: false,
        completion,
      };
    } catch (error) {
      this.cleanupBornDeadAgent(id, options.profileName);
      throw error;
    }
  }

  async resume(agentId: string, options: RunSubagentOptions, context?: BatchExecutionContext): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions, context);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions, context?: BatchExecutionContext): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        this.emitSubagentStarted(parent, agentId);
        const { llm, selectedModel } = createChildLLM({
          parent,
          child,
          circuitBreaker: this.circuitBreaker,
          config: this.session.options.config,
          runtimeModel: this._runtimeSubagentModel ?? undefined,
          context,
          log: child.log,
        });
        child.config.update({ modelAlias: selectedModel });
        child.turn.setLLMForTurn(llm);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      } finally {
        child.turn.setLLMForTurn(undefined);
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    // Take epoch snapshot before batch — "memory checkpoint"
    const snapshot = this.session.takeEpochSnapshot();

    const maxConcurrency = resolveSwarmMaxConcurrency();
    const config = this.session.options.config;

    try {
      const results = await new SubagentBatch(this, tasks, { maxConcurrency, fallbackModel: config?.subagentFallbackModel }).run();

      // Commit epoch after successful batch — "atomic pointer swap simulation"
      await this.session.commitEpoch();

      return results;
    } catch (error) {
      // Rollback on failure — "checkpoint restore"
      this.session.rollbackEpoch();
      throw error;
    }
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.setModelAliasResolver(() => this.resolveChildModel(parent));
    child.config.update({
      thinkingLevel: parent.config.thinkingLevel,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  markActiveChildDetached(agentId: string): void {
    this.session.getReadyAgent(agentId)?.config.setModelAliasResolver(undefined);
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  getSwarmItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.swarmItem;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  /**
   * Validate all preconditions before creating a subagent agent.
   * This prevents 'born dead' agents — agents that are created but never
   * receive an LLM call because a later step fails.
   */
  private async validateProvisioningPreconditions(
    parent: Agent,
    profileName: string,
    signal: AbortSignal,
    context?: BatchExecutionContext,
  ): Promise<ProvisioningPreconditionResult> {
    // 1. Validate profile exists
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      return { ok: false, reason: `Subagent profile "${profileName}" not found` };
    }

    // 2. Ensure parent signal is still alive
    if (signal.aborted) {
      return { ok: false, reason: 'Parent signal already aborted' };
    }

    // 3. Validate model can be resolved (delegate to resolveChildModel
    //    to keep all parent model alias access in one place)
    const resolvedModel = this.resolveChildModel(parent, context);
    if (!resolvedModel) {
      return { ok: false, reason: 'No model configured for subagent' };
    }

    // 4. Verify SubagentStart hook is not registered (would block spawn)
    const hookSummary = parent.hooks?.summary;
    if (hookSummary !== undefined && (hookSummary['SubagentStart'] ?? 0) > 0) {
      return { ok: false, reason: 'SubagentStart hook registered and may block spawn' };
    }

    return { ok: true };
  }

  /**
   * Remove a subagent agent from the session after creation to prevent
   * 'born dead' agents from leaking resources.
   */
  private cleanupBornDeadAgent(agentId: string, profileName: string): void {
    this.session.agents.delete(agentId);
    delete this.session.metadata.agents[agentId];
    this.session.log.warn('subagent_born_dead_cleaned', { agentId, profileName });
  }

  private runWithActiveChild(
    childId: string,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
    });

    return run({ ...options, signal: controller.signal }).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(childId);
    });
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
    context?: BatchExecutionContext,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    const { llm, selectedModel } = createChildLLM({
      parent,
      child,
      circuitBreaker: this.circuitBreaker,
      config: this.session.options.config,
      runtimeModel: this._runtimeSubagentModel ?? undefined,
      context,
      log: child.log,
    });
    child.config.update({ modelAlias: selectedModel });
    child.turn.setLLMForTurn(llm);
    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    try {
      return await this.waitForChildCompletion(parent, childId, child, profileName, options);
    } finally {
      child.turn.setLLMForTurn(undefined);
    }
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);

    // A subagent that returns an overly terse summary leaves the parent
    // agent under-informed. Give it a bounded number of chances to expand
    // the handoff; if it is still short after that, accept it as-is rather
    // than retrying indefinitely.
    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
    }
    result = parent.projection.projectSubagentResult(result, 'sub');
    const usage = child.usage.data().total;
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    parent.context.stateManifest.update((m) => {
      m.completedTasks.set(childId, {
        taskId: childId,
        summary: result.slice(0, 200),
        status: 'success',
      });
    });
    this.triggerSubagentStop(parent, profileName, result);
    return { result, usage };
  }

  /**
   * Single source of truth for the model a subagent should use.
   * Uses the pure model-router function with circuit breaker awareness
   * for deterministic, verifiable routing decisions.
   */
  private resolveChildModel(parent: Agent, context?: BatchExecutionContext, child?: Agent): string {
    const config = this.session.options.config;

    // Build a dynamic model→provider map from the child's ModelProvider
    const dynamicProviderMap = new Map<string, string>();
    if (child?.modelProvider) {
      const candidateModels = [
        this._runtimeSubagentModel,
        config?.subagentModel,
        parent.config.modelAlias,
        config?.defaultModel,
        config?.subagentFallbackModel,
      ].filter((m): m is string => !!m);
      for (const model of new Set(candidateModels)) {
        try {
          const { providerName } = child.modelProvider.resolveProviderConfig(model);
          dynamicProviderMap.set(model, providerName);
        } catch {
          // unregistered model — skip
        }
      }
    }

    // Build snapshot for deterministic routing
    const snapshot = createRoutingSnapshot({
      isRateLimited: context?.isRateLimited ?? false,
      runtimeModel: this._runtimeSubagentModel ?? undefined,
      configSubagentModel: config?.subagentModel ?? undefined,
      parentModel: parent.config.modelAlias ?? undefined,
      defaultModel: config?.defaultModel ?? undefined,
      fallbackPriority: config?.subagentFallbackModel
        ? [config.subagentFallbackModel]
        : undefined,
      circuitStates: createCircuitSnapshot(this.circuitBreaker),
      modelProviderMap: dynamicProviderMap,
    });

    const output = resolveModel(snapshot);
    return output.selectedModel;
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    context?: BatchExecutionContext,
    contract?: SubagentContract,
  ): Promise<void> {
    child.config.update({
      cwd: parent.config.cwd,
      thinkingLevel: parent.config.thinkingLevel,
      temperature: profile.temperature,
      seed: profile.seed,
    });

    const promptContext = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
      { additionalDirs: child.getAdditionalDirs(), agentType: child.type },
    );
    child.useProfile(profile, promptContext);

    // Inject contract data into the child's context AFTER the system prompt
    // (set by useProfile) but BEFORE any user-provided prompt template content
    // is sent in runPromptTurn. This ensures the child has deterministic
    // knowledge of its task scope and role before receiving its prompt.
    if (contract !== undefined) {
      child.context.appendSystemReminder(renderContractAsReminder(contract), {
        kind: 'injection',
        variant: 'subagent_contract',
      });
    }

    child.tools.inheritUserTools(parent.tools);

    // Sub-agents must not have access to orchestration tools (e.g. AgentSwarm)
    // to prevent infinite nesting of swarm calls.
    child.tools.removeFromActiveTools([...ORCHESTRATION_TOOLS]);

    // If the parent is in plan mode, physically remove write tools from the child
    // to prevent circumventing plan-mode restrictions through delegation.
    if (parent.planMode.isActive) {
      child.parentPlanModeActive = true;
      child.tools.removeFromActiveTools(['Write', 'Edit']);
    }
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    options: RunSubagentOptions,
    error: unknown,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.reason === 'filtered') {
      throw new Error('Subagent turn blocked by provider safety policy');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}
