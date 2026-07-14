import { describe, expect, it, vi } from 'vitest';

import { FakeTransport } from '../transport/fake.js';
import { ClaudeCodeAdapter } from './claude-code.js';
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
