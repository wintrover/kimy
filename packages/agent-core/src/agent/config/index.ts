import {
  createProvider,
  KimiChatProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type GenerationKwargs,
  type ModelCapability,
  type ProviderConfig,
} from '@moonshot-ai/kosong';

import { applyKimiEnvSamplingParams, applyKimiEnvThinkingKeep } from '#/config/kimi-env-params';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '../../errors';
import type { AgentConfigData, AgentConfigUpdateData } from './types';
import { resolveThinkingEffort, type ThinkingEffort } from './thinking';
import type { ResolvedRuntimeProvider } from '../../session/provider-manager';

export * from './types';
export { resolveThinkingEffort, type ThinkingEffort } from './thinking';

export class ConfigState {
  private _cwd: string;
  private _modelAlias: string | undefined;
  private _profileName: string | undefined;
  private _thinkingLevel: ThinkingEffort = 'off';
  private _systemPrompt: string = '';
  private _temperature: number | undefined;
  private _seed: number | undefined;
  private _modelAliasResolver?: () => string | undefined;

  constructor(protected readonly agent: Agent) {
    this._cwd = agent.kaos.getcwd();
    this._modelAlias = agent.modelProvider?.defaultModel;
  }

  update(changed: AgentConfigUpdateData): void {
    if (Object.keys(changed).length === 0) return;

    this.agent.records.logRecord({
      type: 'config.update',
      ...changed,
    });
    this.agent.replayBuilder.push({
      type: 'config_updated',
      config: changed,
    });
    if (changed.cwd) {
      this._cwd = changed.cwd;
      void this.agent.kaos.chdir(changed.cwd);
    }
    if (changed.modelAlias) {
      this._modelAlias = changed.modelAlias;
    }
    if (changed.profileName) {
      this._profileName = changed.profileName;
    }
    if (changed.thinkingLevel !== undefined) {
      this._thinkingLevel = resolveThinkingEffort(
        changed.thinkingLevel,
        this.agent.kimiConfig?.thinking,
      );
    }
    if (changed.systemPrompt !== undefined) {
      this._systemPrompt = changed.systemPrompt;
    }
    if (changed.temperature !== undefined) {
      this._temperature = changed.temperature;
    }
    if (changed.seed !== undefined) {
      this._seed = changed.seed;
    }
    if (this.hasProvider && (changed.cwd !== undefined || changed.modelAlias)) {
      this.agent.tools.initializeBuiltinTools();
    }
    this.agent.emitStatusUpdated();
  }

  /**
   * Install (or clear) a lazy model-alias resolver for subagents.
   * When set, the `modelAlias` getter falls back to the resolver
   * whenever `_modelAlias` is undefined, enabling IoC Pull semantics
   * so lifecycle methods never need to push modelAlias explicitly.
   */
  setModelAliasResolver(resolver: (() => string | undefined) | undefined): void {
    this._modelAliasResolver = resolver;
    if (resolver !== undefined && this.hasProvider) {
      this.agent.tools.initializeBuiltinTools();
    }
  }

  data(): AgentConfigData {
    const resolved = this.tryResolvedProviderConfig();
    return {
      cwd: this.cwd,
      provider: resolved?.provider,
      modelAlias: this._modelAlias,
      modelCapabilities: resolved?.modelCapabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
      temperature: this._temperature,
      seed: this._seed,
    };
  }

  get cwd(): string {
    return this._cwd;
  }

  get hasModel(): boolean {
    return this.modelAlias !== undefined;
  }

  get hasProvider(): boolean {
    return this.tryResolvedProviderConfig() !== undefined;
  }

  get providerConfig(): ProviderConfig {
    const provider = this.resolvedProviderConfig?.provider;
    if (provider === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    return provider;
  }

  get provider(): ChatProvider {
    // All provider-level request config is applied here so every request built
    // from config.provider — the main loop AND full-history compaction — carries it:
    //   - withThinking: preserve thinking during compaction (#464)
    //   - sampling params: KIMI_MODEL_TEMPERATURE / KIMI_MODEL_TOP_P
    //   - thinking.keep: KIMI_MODEL_THINKING_KEEP (only while thinking is on)
    let provider = createProvider(this.providerConfig);
    // Only enable thinking for models that support it. Models with
    // thinking: false (e.g. minimax-m3) must not receive reasoning_effort
    // parameters, which would cause 400 errors from their API.
    // UNKNOWN_CAPABILITY defaults thinking to false, so unknown models
    // are also safely excluded.
    if (this.modelCapabilities.thinking) {
      provider = provider.withThinking(this.thinkingLevel);
    }
    const withEnv = applyKimiEnvThinkingKeep(applyKimiEnvSamplingParams(provider), this.thinkingLevel);
    return this.applyProfileSamplingParams(withEnv);
  }

  private applyProfileSamplingParams(provider: ChatProvider): ChatProvider {
    if (!(provider instanceof KimiChatProvider)) return provider;
    const kwargs: GenerationKwargs = {};
    if (this._temperature !== undefined) kwargs.temperature = this._temperature;
    if (this._seed !== undefined) kwargs.extra_body = { seed: this._seed };
    return Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;
  }

  get model(): string {
    const alias = this.modelAlias;
    if (alias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return alias;
  }

  get modelAlias(): string | undefined {
    return this._modelAliasResolver?.() ?? this._modelAlias;
  }

  get thinkingLevel(): ThinkingEffort {
    // Always-thinking models cannot run with thinking disabled. Clamping in
    // the getter (rather than in update()) keeps the request builder, status
    // events, and subagent inheritance consistent, and re-applies after a
    // later model switch onto an always-thinking alias.
    if (this._thinkingLevel === 'off' && this.alwaysThinkingModel) {
      return resolveThinkingEffort('on', this.agent.kimiConfig?.thinking);
    }
    return this._thinkingLevel;
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolvedProviderConfig()?.alwaysThinking === true;
  }

  get profileName(): string | undefined {
    return this._profileName;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get modelCapabilities(): ModelCapability {
    return this.tryResolvedProviderConfig()?.modelCapabilities ?? UNKNOWN_CAPABILITY;
  }

  get maxOutputSize(): number | undefined {
    return this.tryResolvedProviderConfig()?.maxOutputSize;
  }

  private get resolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    const alias = this.modelAlias;
    if (alias === undefined) return undefined;
    return this.agent.modelProvider?.resolveProviderConfig(alias);
  }

  private tryResolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    try {
      return this.resolvedProviderConfig;
    } catch {
      return undefined;
    }
  }
}
