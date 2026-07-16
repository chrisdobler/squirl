import { describe, expect, it, vi } from 'vitest';

import { FakeTransport } from '../transport/fake.js';
import {
  boundClaudeWorkflowInput,
  claudeWorkflowBudgetHook,
  CLAUDE_DEEP_RESEARCH_MAX_FETCH,
  CLAUDE_DEEP_RESEARCH_MAX_VERIFY_CLAIMS,
  ClaudeCodeAdapter,
} from './claude-code.js';
import { CodexAdapter } from './codex.js';
import type { AgentDescriptor, AgentEvent } from '../types.js';

const claudeDescriptor: AgentDescriptor = {
  id: 'cc', kind: 'claude-code', label: 'claude-code', transport: 'local', cwd: '/repo',
};
const codexDescriptor: AgentDescriptor = {
  id: 'codex', kind: 'codex', label: 'codex', transport: 'local', cwd: '/repo',
};

function messages(transport: FakeTransport): Array<Record<string, any>> {
  return transport.lastSpawn.handle.writes.map((line) => JSON.parse(line));
}

async function startCodex(agent: CodexAdapter, transport: FakeTransport, threadId = 'thread-1'): Promise<void> {
  const starting = agent.start();
  let initialize: Record<string, any> | undefined;
  await vi.waitFor(() => { initialize = messages(transport).find((message) => message.method === 'initialize'); expect(initialize).toBeTruthy(); });
  transport.lastSpawn.handle.emitStdout(JSON.stringify({ id: initialize!.id, result: {} }));
  let thread: Record<string, any> | undefined;
  await vi.waitFor(() => { thread = messages(transport).find((message) => message.method === 'thread/start' || message.method === 'thread/resume'); expect(thread).toBeTruthy(); });
  transport.lastSpawn.handle.emitStdout(JSON.stringify({ id: thread!.id, result: { thread: { id: threadId }, model: 'gpt-test' } }));
  await starting;
}

describe('ClaudeCodeAdapter', () => {
  it('bounds bundled deep-research verification fan-out before provider execution', () => {
    const input = {
      scriptPath: '/tmp/deep-research.js',
      script: [
        "export const meta = { name: 'deep-research' }",
        'const MAX_FETCH = 15',
        'const MAX_VERIFY_CLAIMS = 25',
        'const novel = sorted.filter(r => {',
        'if (fetchSlots <= 0 && relRank[r.relevance] >= 1) return false',
        '})',
        'claims: ext.claims.map(c => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })),',
        'const rankedClaims = [...allClaims]',
        '  .sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))',
        '  .slice(0, MAX_VERIFY_CLAIMS)',
      ].join('\n'),
      args: 'Research this',
    };

    const bounded = boundClaudeWorkflowInput('Workflow', input);

    expect(bounded).not.toBe(input);
    expect(bounded.script).toContain(`const MAX_FETCH = ${CLAUDE_DEEP_RESEARCH_MAX_FETCH}`);
    expect(bounded.script).toContain(`const MAX_VERIFY_CLAIMS = ${CLAUDE_DEEP_RESEARCH_MAX_VERIFY_CLAIMS}`);
    expect(bounded.script).toContain('if (fetchSlots <= 0) return false');
    expect(bounded.script).not.toContain('fetchSlots <= 0 &&');
    expect(bounded.script).toContain('sorted.slice(0, 2).filter');
    expect(bounded.script).toContain('sourceAngle: searchResult.angle');
    expect(bounded.script).toContain('const representedAngles = new Set()');
    expect(bounded.script).not.toContain('.slice(0, MAX_VERIFY_CLAIMS)');
    expect(bounded).toMatchObject({ scriptPath: input.scriptPath, args: input.args });
    expect(input.script).toContain('MAX_VERIFY_CLAIMS = 25');
  });

  it('does not rewrite other workflows or an already smaller research budget', () => {
    const other = { script: "export const meta = { name: 'other' }\nconst MAX_VERIFY_CLAIMS = 25" };
    const small = { script: "export const meta = { name: \"deep-research\" }\nconst MAX_FETCH = 8\nconst MAX_VERIFY_CLAIMS = 2" };

    expect(boundClaudeWorkflowInput('Workflow', other)).toBe(other);
    expect(boundClaudeWorkflowInput('Workflow', small)).toBe(small);
    expect(boundClaudeWorkflowInput('Bash', {
      script: "export const meta = { name: 'deep-research' }\nconst MAX_VERIFY_CLAIMS = 25",
    })).toEqual({
      script: "export const meta = { name: 'deep-research' }\nconst MAX_VERIFY_CLAIMS = 25",
    });
  });

  it('applies the same budget in the pre-tool hook used by bypassPermissions sessions', async () => {
    const output = await claudeWorkflowBudgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Workflow',
      tool_input: {
        script: "export const meta = { name: 'deep-research' }\nconst MAX_FETCH = 15\nconst MAX_VERIFY_CLAIMS = 25",
      },
      tool_use_id: 'workflow-1',
      session_id: 'session-1',
      transcript_path: '/tmp/session.jsonl',
      cwd: '/repo',
      permission_mode: 'bypassPermissions',
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          script: expect.stringContaining(`MAX_VERIFY_CLAIMS = ${CLAUDE_DEEP_RESEARCH_MAX_VERIFY_CLAIMS}`),
        },
      },
    });
  });
  it.each(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] as const)('accepts the configured %s SDK permission mode', async (permissionMode) => {
    const agent = new ClaudeCodeAdapter({ ...claudeDescriptor, permissionMode }, new FakeTransport());
    expect(agent.buildArgs().join(' ')).toContain(`--permission-mode ${permissionMode}`);
    await agent.start();
    expect(agent.status).toBe('ready');
  });

  it('preserves model, effort, and resume configuration for diagnostics', () => {
    const agent = new ClaudeCodeAdapter({ ...claudeDescriptor, model: 'fable', effort: 'medium', sessionId: 'session-1' }, new FakeTransport());
    expect(agent.buildArgs()).toEqual(['--permission-mode', 'acceptEdits', '--model', 'fable', '--effort', 'medium', '--resume', 'session-1']);
  });
});

describe('CodexAdapter app-server', () => {
  it('initializes a persistent app server with the configured sandbox and approval policy', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter({ ...codexDescriptor, model: 'gpt-5', effort: 'high', sandbox: 'read-only', approvalPolicy: 'untrusted' }, transport);
    await startCodex(agent, transport);

    expect(transport.lastSpawn.spec.args).toEqual(['app-server']);
    const thread = messages(transport).find((message) => message.method === 'thread/start')!;
    expect(thread.params).toMatchObject({ cwd: '/repo', model: 'gpt-5', sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });

    const sending = agent.send('list the files');
    await Promise.resolve();
    const turn = messages(transport).find((message) => message.method === 'turn/start')!;
    expect(turn.params).toMatchObject({ threadId: 'thread-1', input: [{ type: 'text', text: 'list the files' }], effort: 'high' });
    transport.lastSpawn.handle.emitStdout(JSON.stringify({ id: turn.id, result: { turn: { id: 'turn-1' } } }));
    await sending;
  });

  it('streams assistant output and maps command approvals to session decisions', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter(codexDescriptor, transport);
    const events: AgentEvent[] = [];
    agent.onEvent((event) => events.push(event));
    await startCodex(agent, transport);

    transport.lastSpawn.handle.emitStdout(JSON.stringify({
      id: 99, method: 'item/commandExecution/requestApproval',
      params: { itemId: 'cmd-1', command: 'curl https://example.com', reason: 'Network access', availableDecisions: ['accept', 'acceptForSession', 'decline'] },
    }));
    await Promise.resolve();
    const interaction = events.find((event) => event.type === 'interaction-request');
    expect(interaction).toMatchObject({ request: { method: 'permission', toolName: 'Bash', resource: 'curl https://example.com' } });
    if (interaction?.type !== 'interaction-request') throw new Error('missing interaction');
    await agent.respondToInteraction(interaction.request.id, { decision: 'allow-session' });
    await Promise.resolve();
    expect(messages(transport)).toContainEqual({ id: 99, result: { decision: 'acceptForSession' } });

    transport.lastSpawn.handle.emitStdout(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hello', itemId: 'msg-1', turnId: 'turn-1', threadId: 'thread-1' } }));
    transport.lastSpawn.handle.emitStdout(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }));
    expect(events.filter((event) => event.type === 'token').map((event) => event.type === 'token' ? event.token : '')).toEqual(['hello']);
    expect(events.some((event) => event.type === 'turn-end')).toBe(true);
  });

  it('offers always allow for Codex network policy amendments', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter(codexDescriptor, transport);
    const events: AgentEvent[] = [];
    agent.onEvent((event) => events.push(event));
    await startCodex(agent, transport);
    const policyDecision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'db.example.com', action: 'allow' },
      },
    };

    transport.lastSpawn.handle.emitStdout(JSON.stringify({
      id: 100, method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'cmd-2',
        command: 'psql -h db.example.com',
        reason: 'Network access',
        availableDecisions: ['accept', policyDecision, 'decline'],
      },
    }));
    await Promise.resolve();
    const interaction = events.find((event) => event.type === 'interaction-request');
    expect(interaction).toMatchObject({
      request: {
        method: 'permission',
        sessionScope: { label: 'Always allow network access to db.example.com' },
      },
    });
    if (interaction?.type !== 'interaction-request') throw new Error('missing interaction');
    await agent.respondToInteraction(interaction.request.id, { decision: 'allow-session' });
    await Promise.resolve();
    expect(messages(transport)).toContainEqual({ id: 100, result: { decision: policyDecision } });
  });

  it('resumes an existing thread and denies experimental broad permission profiles', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter({ ...codexDescriptor, sessionId: 'saved-thread' }, transport);
    const events: AgentEvent[] = [];
    agent.onEvent((event) => events.push(event));
    await startCodex(agent, transport, 'saved-thread');
    expect(messages(transport).find((message) => message.method === 'thread/resume')?.params.threadId).toBe('saved-thread');

    transport.lastSpawn.handle.emitStdout(JSON.stringify({ id: 44, method: 'item/permissions/requestApproval', params: { itemId: 'broad' } }));
    await Promise.resolve();
    expect(messages(transport)).toContainEqual({ id: 44, error: { code: -32601, message: 'Squirl does not support experimental permission profile grants.' } });
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
