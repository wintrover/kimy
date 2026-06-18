import { randomUUID } from 'node:crypto';

import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type ContentPart,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type { Agent } from '../agent';
import type { ExecutableTool } from '../loop';
import {
  allocateSubagentWorkspace,
  ArtifactSchemaRegistry,
  FileSystemAgentLedger,
  SubagentFSM,
  type ArtifactRecord,
  type SubagentWorkspacePaths,
} from '../agent/artifact';
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
import type { Session } from './index';
import {
  SubagentBatch,
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
  readonly output_mode?: 'artifact' | 'text';
  readonly isolate_workspace?: boolean;
  readonly isRecoverySynthesis?: boolean;
  /**
   * When true, the subagent host runs a `sequential-thinking` reasoning step
   * before the first LLM turn and aborts the subagent if reasoning fails.
   */
  readonly isCriticalTask?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
  readonly artifact?: ArtifactRecord;
};

export class MissingArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingArtifactError';
  }
}

export class NoCheckpointArtifactError extends MissingArtifactError {
  constructor(childId: string) {
    super(
      `Subagent ${childId} finished in artifact mode without checkpoints; synthesis is not possible.`,
    );
    this.name = 'NoCheckpointArtifactError';
  }
}

export class SynthesisArtifactError extends Error {
  constructor(
    message: string,
    readonly originalError: Error,
    readonly synthesisError?: Error,
  ) {
    super(message);
    this.name = 'SynthesisArtifactError';
  }
}

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly runInBackground: boolean;
    }
  >();
  private recoveryDepth = 0;

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
  ) {}

  private resolveSubagentModel(parent: Agent): string | undefined {
    return this.session.options.config?.subagentModel ?? parent.config.modelAlias;
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    const outputMode = options.output_mode ?? 'text';
    const isolateWorkspace = options.isolate_workspace ?? true;
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem },
    );

    let artifactWorkspacePaths: SubagentWorkspacePaths | undefined;
    if (outputMode === 'artifact') {
      const sessionHome = this.session.options.kimiHomeDir ?? parent.homedir;
      if (sessionHome === undefined) {
        throw new Error('Cannot spawn artifact-mode subagent without a session home directory');
      }
      const workspace = await allocateSubagentWorkspace({
        sessionHome,
        agentId: id,
      });
      artifactWorkspacePaths = workspace.paths;
      const ledger = new FileSystemAgentLedger({
        agentId: id,
        artifactsDir: workspace.paths.artifacts,
      });
      const schemaRegistry = ArtifactSchemaRegistry.default();
      if (profile.outputSchema !== undefined) {
        schemaRegistry.registerJsonSchema(profile.name, profile.outputSchema);
      }
      agent.artifacts = {
        ledger,
        fsm: new SubagentFSM(),
        profileName: profile.name,
        schemaRegistry,
      };
      agent.artifacts.fsm.transition('exploring');
    }

    const completion = this.runWithActiveChild(id, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, id, profile.name, runOptions);
      try {
        await this.configureChild(parent, agent, profile, {
          outputMode,
          workspacePaths: artifactWorkspacePaths,
          isolateWorkspace,
        });
        return await this.runPromptTurn(parent, id, agent, profile.name, runOptions);
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
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
        child.config.update({ modelAlias: this.resolveSubagentModel(parent) });
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        child.config.update({ modelAlias: this.resolveSubagentModel(parent) });
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
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
    return new SubagentBatch(this, tasks).run();
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

    child.config.update({
      modelAlias: this.resolveSubagentModel(parent),
      thinkingLevel: parent.config.thinkingLevel,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    const childCaps = child.config.data().modelCapabilities;
    if (!childCaps.tool_use) {
      parent.log.warn('BTW subagent model lacks tool_use; guardrail pipeline will expose no tools', {
        modelAlias: child.config.modelAlias,
      });
    }
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

  private resolveSynthesisProfile(): ResolvedAgentProfile {
    const profile = DEFAULT_AGENT_PROFILES['synthesis'];
    if (profile === undefined) {
      throw new Error('Synthesis profile was not found');
    }
    return profile;
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
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    await runReasoningBootstrap(child, profileName, options);
    options.signal.throwIfAborted();

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    return this.waitForChildCompletion(parent, childId, child, profileName, options);
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);

    const outputMode = options.output_mode ?? 'text';
    if (outputMode === 'artifact') {
      return this.waitForArtifactCompletion(parent, childId, child, profileName, options);
    }

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
    const usage = child.usage.data().total;
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    this.triggerSubagentStop(parent, profileName, result);
    return { result, usage };
  }

  private async waitForArtifactCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    const artifacts = child.artifacts;
    if (artifacts === undefined) {
      throw new Error(`Subagent ${childId} is in artifact mode but has no artifact ledger`);
    }

    const usage = child.usage.data().total;
    const committed = await artifacts.ledger.read('final');

    if (committed !== undefined) {
      const result = JSON.stringify(committed.payload);
      parent.emitEvent({
        type: 'subagent.completed',
        subagentId: childId,
        resultSummary: result,
        usage,
        contextTokens: child.context.tokenCount,
      });
      this.triggerSubagentStop(parent, profileName, result);
      return { result, usage, artifact: committed };
    }

    // 0) Hard-coded guard against re-entrant recovery.
    if (options.isRecoverySynthesis) {
      throw new Error(
        `Subagent ${childId} completed without final artifact during recovery synthesis; refusing re-entrant recovery.`,
      );
    }

    // 1) Detect checkpoints; if none exist, fail fast.
    const checkpoints = await artifacts.ledger.readCheckpoints(10);
    if (checkpoints.length === 0) {
      throw new NoCheckpointArtifactError(childId);
    }

    // 2) Run a single-shot stateless synthesis subagent.
    return this.runSynthesisRecovery(parent, child, childId, profileName, checkpoints, options);
  }

  private async runSynthesisRecovery(
    parent: Agent,
    failedChild: Agent,
    childId: string,
    profileName: string,
    checkpoints: ArtifactRecord[],
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();

    if (options.isRecoverySynthesis) {
      throw new Error('runSynthesisRecovery called on a recovery subagent');
    }
    this.recoveryDepth += 1;
    if (this.recoveryDepth > 1) {
      this.recoveryDepth -= 1;
      throw new Error('Recovery depth exceeded 1');
    }

    const artifactsDir = failedChild.artifacts!.ledger.artifactsDir;

    const cleaned = await cleanupArtifactTmpFiles(artifactsDir);

    const { id, agent: synth } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId },
    );

    parent.telemetry.track('subagent.synthesis_recovery.tmp_cleaned', {
      original_subagent_id: childId,
      synthesis_subagent_id: id,
      deleted_count: cleaned.length,
      artifacts_dir: artifactsDir,
    });

    const ledger = new FileSystemAgentLedger({ agentId: id, artifactsDir });
    const originalProfile = this.resolveProfile(parent, profileName);
    const schemaRegistry = ArtifactSchemaRegistry.default();
    if (originalProfile.outputSchema !== undefined) {
      schemaRegistry.registerJsonSchema(originalProfile.name, originalProfile.outputSchema);
    }
    synth.artifacts = {
      ledger,
      fsm: new SubagentFSM(),
      profileName: originalProfile.name,
      schemaRegistry,
    };
    synth.artifacts.fsm.transition('exploring');

    const synthesisProfile = this.resolveSynthesisProfile();
    await this.configureChild(parent, synth, synthesisProfile, {
      outputMode: 'artifact',
      inheritUserTools: false,
    });
    // profileName stays bound to the original profile so that YieldArtifact validates
    // the final payload against the original output schema.

    const prompt = buildSynthesisPrompt(originalProfile.name, options.prompt, checkpoints);

    const synthOptions: RunSubagentOptions = {
      ...options,
      isRecoverySynthesis: true,
    };

    parent.telemetry.track('subagent.synthesis_recovery.triggered', {
      original_subagent_id: childId,
      synthesis_subagent_id: id,
      original_profile: originalProfile.name,
      checkpoint_count: checkpoints.length,
    });

    try {
      synth.turn.prompt([{ type: 'text', text: prompt }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(synth, synthOptions.signal);

      const final = await ledger.read('final');
      if (final === undefined) {
        throw new Error('Synthesis subagent did not yield a final artifact.');
      }

      parent.telemetry.track('subagent.synthesis_recovery.succeeded', {
        original_subagent_id: childId,
        synthesis_subagent_id: id,
        original_profile: originalProfile.name,
        checkpoint_count: checkpoints.length,
      });

      const result = JSON.stringify(final.payload);
      parent.emitEvent({
        type: 'subagent.completed',
        subagentId: childId,
        resultSummary: result,
        usage: synth.usage.data().total,
        contextTokens: synth.context.tokenCount,
      });
      this.triggerSubagentStop(parent, profileName, result);
      return { result, usage: synth.usage.data().total, artifact: final };
    } catch (synthesisError) {
      parent.telemetry.track('subagent.synthesis_recovery.failed', {
        original_subagent_id: childId,
        synthesis_subagent_id: id,
        original_profile: originalProfile.name,
        checkpoint_count: checkpoints.length,
      });
      throw new SynthesisArtifactError(
        `Synthesis recovery failed for subagent ${childId}.`,
        new MissingArtifactError(`Subagent ${childId} finished without final artifact.`),
        synthesisError instanceof Error ? synthesisError : new Error(String(synthesisError)),
      );
    } finally {
      this.recoveryDepth -= 1;
    }
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    options?: {
      readonly outputMode?: 'artifact' | 'text';
      readonly workspacePaths?: SubagentWorkspacePaths;
      readonly isolateWorkspace?: boolean;
      readonly inheritUserTools?: boolean;
    },
  ): Promise<void> {
    const outputMode = options?.outputMode ?? 'text';
    const cwd =
      outputMode === 'artifact' && options?.workspacePaths !== undefined && options.isolateWorkspace !== false
        ? options.workspacePaths.workspace
        : parent.config.cwd;

    child.config.update({
      cwd,
      modelAlias: this.resolveSubagentModel(parent),
      thinkingLevel: parent.config.thinkingLevel,
    });

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
    );
    child.useProfile(profile, context);

    if (outputMode === 'artifact') {
      child.tools.setActiveTools([...profile.tools, 'YieldArtifact']);
    }

    if (options?.inheritUserTools !== false) {
      child.tools.inheritUserTools(parent.tools);
    }

    const childCaps = child.config.data().modelCapabilities;
    if (!childCaps.tool_use) {
      parent.log.warn('subagent model lacks tool_use; guardrail pipeline will expose no tools', {
        modelAlias: child.config.modelAlias,
      });
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

const REASONING_PROFILES = new Set(['plan', 'explore']);
const SEQUENTIAL_THINKING_SUFFIX = '__sequentialthinking';

async function runReasoningBootstrap(
  child: Agent,
  profileName: string,
  options: RunSubagentOptions,
): Promise<void> {
  if (!REASONING_PROFILES.has(profileName)) return;

  const tool = findSequentialThinkingTool(child);
  if (tool === undefined) {
    child.log.debug('sequential-thinking MCP tool not available; skipping reasoning bootstrap', {
      profileName,
    });
    return;
  }

  const signal = options.signal;
  signal.throwIfAborted();

  try {
    const result = await executeTool(tool, {
      thought: options.prompt,
      thoughtNumber: 1,
      totalThoughts: 1,
      nextThoughtNeeded: false,
    }, signal);

    if (result.isError === true) {
      throw new Error(
        typeof result.output === 'string'
          ? result.output
          : 'sequential-thinking returned an error',
      );
    }

    const text = extractText(result.output).trim();
    if (text.length === 0) {
      throw new Error('sequential-thinking returned empty output');
    }

    child.context.appendSystemReminder(
      `Pre-turn reasoning for this ${profileName} task:\n${text}`,
      { kind: 'system_trigger', name: 'reasoning_bootstrap' },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    child.log.warn('reasoning bootstrap failed', { profileName, error: message });
    if (options.isCriticalTask === true) {
      throw new Error(`Critical task reasoning bootstrap failed: ${message}`);
    }
  }
}

function findSequentialThinkingTool(child: Agent): ExecutableTool | undefined {
  return child.tools.loopTools.find((tool) => tool.name.endsWith(SEQUENTIAL_THINKING_SUFFIX));
}

async function executeTool(
  tool: ExecutableTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<import('../loop').ExecutableToolResult> {
  const execution = await tool.resolveExecution(args);
  if ('isError' in execution && execution.isError === true) {
    return execution;
  }
  return execution.execute({
    turnId: 'reasoning-bootstrap',
    toolCallId: randomUUID(),
    signal,
  });
}

function extractText(output: string | ContentPart[]): string {
  if (typeof output === 'string') return output;
  return output.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
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

const ARTIFACT_TMP_PATTERN = /^.*\.json\.tmp-[0-9a-f-]{36}$/;

export async function cleanupArtifactTmpFiles(artifactsDir: string): Promise<string[]> {
  const { readdir, unlink } = await import('node:fs/promises');
  const { resolve } = await import('pathe');
  const deleted: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(artifactsDir);
  } catch {
    return deleted;
  }

  const baseDir = resolve(artifactsDir);
  for (const entry of entries) {
    if (!ARTIFACT_TMP_PATTERN.test(entry)) continue;
    const filePath = resolve(baseDir, entry);
    if (!filePath.startsWith(baseDir)) continue;
    try {
      await unlink(filePath);
      deleted.push(filePath);
    } catch {
      // Cleanup failures must not abort synthesis recovery.
    }
  }
  return deleted;
}

const TRUNCATED_PLACEHOLDER = '"[TRUNCATED_BY_SYSTEM]"';
const TRUNCATED_PLACEHOLDER_LEN = TRUNCATED_PLACEHOLDER.length;
const SYNTHESIS_TOTAL_PAYLOAD_BUDGET_CHARS = 6144;
const SYNTHESIS_PROMPT_OVERHEAD_CHARS = 512;

export function compactPayload(obj: unknown, budget: number): string {
  const { serialized } = compactValue(obj, budget);
  return serialized;
}

interface CompactValueResult {
  readonly serialized: string;
  readonly length: number;
}

function compactValue(obj: unknown, budget: number): CompactValueResult {
  if (obj === null || typeof obj !== 'object') {
    const serialized = JSON.stringify(obj);
    return { serialized, length: serialized.length };
  }

  if (Array.isArray(obj)) {
    const parts: string[] = [];
    let length = 2; // '[' + ']'
    for (const item of obj) {
      const sep = parts.length === 0 ? '' : ',';
      if (length + sep.length + TRUNCATED_PLACEHOLDER_LEN > budget) {
        parts.push(TRUNCATED_PLACEHOLDER);
        length += sep.length + TRUNCATED_PLACEHOLDER_LEN;
        break;
      }
      const itemResult = compactValue(item, Math.max(0, budget - length - sep.length));
      if (length + sep.length + itemResult.length > budget) {
        parts.push(TRUNCATED_PLACEHOLDER);
        length += sep.length + TRUNCATED_PLACEHOLDER_LEN;
        break;
      }
      parts.push(itemResult.serialized);
      length += sep.length + itemResult.length;
    }
    return { serialized: `[${parts.join(',')}]`, length };
  }

  const entries: string[] = [];
  let length = 2; // '{' + '}'
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const sep = entries.length === 0 ? '' : ',';
    const keySerialized = JSON.stringify(key);
    if (length + sep.length + keySerialized.length + 1 + TRUNCATED_PLACEHOLDER_LEN > budget) {
      entries.push(`${sep}${keySerialized}:${TRUNCATED_PLACEHOLDER}`);
      length += sep.length + keySerialized.length + 1 + TRUNCATED_PLACEHOLDER_LEN;
      break;
    }
    const valueResult = compactValue(
      value,
      Math.max(0, budget - length - sep.length - keySerialized.length - 1),
    );
    const entry = `${keySerialized}:${valueResult.serialized}`;
    if (length + sep.length + entry.length > budget) {
      entries.push(`${sep}${keySerialized}:${TRUNCATED_PLACEHOLDER}`);
      length += sep.length + keySerialized.length + 1 + TRUNCATED_PLACEHOLDER_LEN;
      break;
    }
    entries.push(`${sep}${entry}`);
    length += sep.length + entry.length;
  }
  return { serialized: `{${entries.join('')}}`, length };
}

export function buildSynthesisPrompt(
  originalProfileName: string,
  originalPrompt: string,
  checkpoints: ArtifactRecord[],
): string {
  const totalPayloadBudget = Math.max(
    1024,
    SYNTHESIS_TOTAL_PAYLOAD_BUDGET_CHARS - SYNTHESIS_PROMPT_OVERHEAD_CHARS,
  );
  const perPayloadBudget = Math.floor(totalPayloadBudget / Math.max(1, checkpoints.length));

  const blocks = checkpoints.map((checkpoint) =>
    [
      '---',
      `artifact_id: ${checkpoint.artifactId}`,
      `sequence: ${checkpoint.sequence}`,
      `schema_version: ${checkpoint.schemaVersion}`,
      '---',
      compactPayload(checkpoint.payload, perPayloadBudget),
    ].join('\n'),
  );

  return [
    '# Synthesis Recovery Task',
    '',
    `Original profile: ${originalProfileName}`,
    'Original task:',
    originalPrompt,
    '',
    `## Checkpoint artifacts (${checkpoints.length})`,
    ...blocks,
    '',
    'Now produce the single final artifact by calling YieldArtifact with finalize: true.',
  ].join('\n');
}
