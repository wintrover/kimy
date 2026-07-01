import { describe, it, expect } from 'vitest';
import { DEFAULT_AGENT_PROFILES } from '#/profile/default';
import { ContextProjection } from '#/agent/context/context-projection';
import { stripOrchestratorOnlyBlocks } from '#/profile/context';

describe('Profile Security: Orchestrator cannot have coding tools', () => {
  const FORBIDDEN_TOOLS = ['Edit', 'Write', 'Bash'];

  it('delegator profile should not contain Edit, Write, or Bash', () => {
    const delegator = DEFAULT_AGENT_PROFILES['delegator'];
    expect(delegator).toBeDefined();

    const violations = delegator.tools.filter(t => FORBIDDEN_TOOLS.includes(t));

    expect(violations).toEqual([]);
  });

  it('all orchestrator-type profiles should not contain coding tools', () => {
    for (const [name, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      if (profile.type === 'orchestrator') {
        const violations = profile.tools.filter(t => FORBIDDEN_TOOLS.includes(t));

        expect(
          violations,
          `Profile "${name}" (orchestrator) contains forbidden tools: ${violations.join(', ')}`
        ).toEqual([]);
      }
    }
  });
});

describe('Context Projection: Downstream sanitizer (orchestrator → sub-agent)', () => {
  const subProjection = new ContextProjection('sub');

  it('should strip <system-reminder> blocks from tool results for sub-agents', () => {
    const input = [
      'Some tool output here.',
      '<system-reminder>\nPlan mode is active. You may only write to the plan file.\n</system-reminder>',
      'More tool output.',
    ].join('\n');

    const result = subProjection.projectToolResult(input);

    expect(result).not.toContain('<system-reminder>');
    expect(result).not.toContain('Plan mode is active');
    expect(result).toContain('Some tool output here.');
    expect(result).toContain('More tool output.');
  });

  it('should strip multiple <system-reminder> blocks', () => {
    const input = [
      '<system-reminder>First reminder</system-reminder>',
      'Content',
      '<system-reminder>Second reminder</system-reminder>',
    ].join('\n');

    const result = subProjection.projectToolResult(input);

    expect(result).not.toContain('<system-reminder>');
    expect(result).toContain('Content');
  });

  it('should leave clean tool results unchanged', () => {
    const input = 'Just normal tool output with no special tags.';
    const result = subProjection.projectToolResult(input);
    expect(result).toBe(input);
  });
});

describe('Context Projection: Upstream sanitizer (sub-agent → orchestrator)', () => {
  const mainProjection = new ContextProjection('main');

  it('should strip <system-reminder> blocks from sub-agent completion', () => {
    const input = [
      'Here is the code I wrote:',
      '```ts',
      'const x = 1;',
      '```',
      '<system-reminder>\nSome leaked reminder\n</system-reminder>',
    ].join('\n');

    const result = mainProjection.projectSubagentResult(input, 'sub');

    expect(result).not.toContain('<system-reminder>');
    expect(result).toContain('Here is the code I wrote:');
    expect(result).toContain('const x = 1;');
  });

  it('should strip <subagent_contract> blocks from sub-agent completion', () => {
    const input = [
      'Task complete.',
      '<subagent_contract>\nTask: fix the bug\nScope: src/foo.ts\n</subagent_contract>',
    ].join('\n');

    const result = mainProjection.projectSubagentResult(input, 'sub');

    expect(result).not.toContain('<subagent_contract>');
    expect(result).toContain('Task complete.');
  });

  it('should strip system prompt fragment patterns', () => {
    const input = [
      'You are Kimi Code CLI, an interactive general AI agent.',
      '',
      '# Results',
      'I fixed the bug.',
    ].join('\n');

    const result = mainProjection.projectSubagentResult(input, 'sub');

    expect(result).not.toContain('You are Kimi Code CLI');
    expect(result).toContain('I fixed the bug.');
  });
});

describe('Context Projection: Orchestrator passthrough (no stripping)', () => {
  const mainProjection = new ContextProjection('main');

  it('should NOT strip <system-reminder> from orchestrator tool results', () => {
    const input = [
      'Output.',
      '<system-reminder>\nPlan mode is active.\n</system-reminder>',
    ].join('\n');

    const result = mainProjection.projectToolResult(input);

    expect(result).toContain('<system-reminder>');
    expect(result).toContain('Plan mode is active');
  });

  it('should NOT strip <system-reminder> from independent agent tool results', () => {
    const independentProjection = new ContextProjection('independent');
    const input = [
      'Output.',
      '<system-reminder>\nPlan mode is active.\n</system-reminder>',
    ].join('\n');

    const result = independentProjection.projectToolResult(input);

    expect(result).toContain('<system-reminder>');
  });
});

describe('Role-Aware Prompt: <orchestrator-only> structural tags', () => {
  it('should preserve <orchestrator-only> blocks for main agent', () => {
    const content = [
      '# Common Rules',
      'These apply to everyone.',
      '<orchestrator-only>',
      '## Swarm Mode',
      'Use AgentSwarm for parallel work.',
      '</orchestrator-only>',
      '# More Common Rules',
    ].join('\n');

    const result = stripOrchestratorOnlyBlocks(content, 'main');

    expect(result).toContain('Swarm Mode');
    expect(result).toContain('AgentSwarm');
    expect(result).toContain('<orchestrator-only>');
  });

  it('should strip <orchestrator-only> blocks for sub-agents', () => {
    const content = [
      '# Common Rules',
      'These apply to everyone.',
      '<orchestrator-only>',
      '## Swarm Mode',
      'Use AgentSwarm for parallel work.',
      '</orchestrator-only>',
      '# More Common Rules',
    ].join('\n');

    const result = stripOrchestratorOnlyBlocks(content, 'sub');

    expect(result).not.toContain('<orchestrator-only>');
    expect(result).not.toContain('Swarm Mode');
    expect(result).not.toContain('AgentSwarm');
    expect(result).toContain('Common Rules');
    expect(result).toContain('More Common Rules');
  });

  it('should strip <orchestrator-only> blocks when agentType is undefined', () => {
    const content = [
      '<orchestrator-only>',
      'Orchestrator stuff',
      '</orchestrator-only>',
      'Common stuff',
    ].join('\n');

    const result = stripOrchestratorOnlyBlocks(content, undefined);

    expect(result).not.toContain('Orchestrator stuff');
    expect(result).toContain('Common stuff');
  });
});

describe('Profile Security: System prompt role isolation', () => {
  const orchestratorProfile = DEFAULT_AGENT_PROFILES['delegator'];
  const coderProfile = DEFAULT_AGENT_PROFILES['coder'];

  it('orchestrator system prompt should include system-reminder authority text', () => {
    if (!orchestratorProfile?.systemPromptTemplate) return;
    expect(orchestratorProfile.systemPromptTemplate).toContain('system-reminder');
    expect(orchestratorProfile.systemPromptTemplate).toContain('authoritative system directives');
  });

  it('coder system prompt should NOT include system-reminder authority text', () => {
    if (!coderProfile?.systemPromptTemplate) return;
    expect(coderProfile.systemPromptTemplate).not.toContain('authoritative system directives');
  });

  it('orchestrator system prompt should include Agent delegation instructions', () => {
    if (!orchestratorProfile?.systemPromptTemplate) return;
    expect(orchestratorProfile.systemPromptTemplate).toContain('delegate a focused subtask');
  });

  it('coder system prompt should include Context Awareness section', () => {
    if (!coderProfile?.systemPromptTemplate) return;
    expect(coderProfile.systemPromptTemplate).toContain('Context Awareness');
    expect(coderProfile.systemPromptTemplate).toContain('sub-agent');
  });
});
