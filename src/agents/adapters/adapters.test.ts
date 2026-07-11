import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeTransport } from '../transport/fake.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import type { AgentDescriptor, AgentEvent } from '../types.js';

function fixtureLines(name: string): string[] {
  const raw = readFileSync(new URL(`../parse/__fixtures__/${name}`, import.meta.url), 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

const claudeDescriptor: AgentDescriptor = {
  id: 'cc', kind: 'claude-code', label: 'claude-code', transport: 'local', cwd: '/repo',
};
const codexDescriptor: AgentDescriptor = {
  id: 'codex', kind: 'codex', label: 'codex', transport: 'local', cwd: '/repo',
};

describe('ClaudeCodeAdapter', () => {
  it('spawns a persistent stream-json process with safe defaults', async () => {
    const transport = new FakeTransport();
    const agent = new ClaudeCodeAdapter(claudeDescriptor, transport);
    await agent.start();

    const { spec } = transport.lastSpawn;
    expect(spec.command).toBe('claude');
    expect(spec.args).toContain('--print');
    expect(spec.args).toContain('--input-format');
    expect(spec.args).toContain('stream-json');
    expect(spec.args).toContain('--include-partial-messages');
    // Safe default permission mode, never --bare (would break OAuth), never skip-permissions.
    expect(spec.args.join(' ')).toContain('--permission-mode default');
    expect(spec.args).not.toContain('--bare');
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
    expect(agent.status).toBe('ready');
  });

  it('writes a stream-json user turn to stdin on send', async () => {
    const transport = new FakeTransport();
    const agent = new ClaudeCodeAdapter(claudeDescriptor, transport);
    await agent.start();
    await agent.send('refactor the auth module');

    const written = transport.lastSpawn.handle.stdinData.trim();
    expect(written.endsWith('}')).toBe(true);
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'refactor the auth module' }] } });
    expect(agent.status).toBe('busy');
  });

  it('passes configured model and effort to Claude', async () => {
    const transport = new FakeTransport();
    const agent = new ClaudeCodeAdapter({ ...claudeDescriptor, model: 'fable', effort: 'medium' }, transport);
    await agent.start();
    expect(transport.lastSpawn.spec.args.join(' ')).toContain('--model fable');
    expect(transport.lastSpawn.spec.args.join(' ')).toContain('--effort medium');
  });

  it('emits parsed events as the process streams, and returns to ready at turn end', async () => {
    const transport = new FakeTransport();
    const agent = new ClaudeCodeAdapter(claudeDescriptor, transport);
    const events: AgentEvent[] = [];
    await agent.start();
    agent.onEvent((e) => events.push(e));
    await agent.send('hi');

    transport.lastSpawn.handle.emitStdoutLines(fixtureLines('claude-message.jsonl'));

    const text = events.filter((e) => e.type === 'token').map((e) => (e as { token: string }).token).join('');
    expect(text).toBe('turn one ok.');
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
    expect(agent.status).toBe('ready');
    // Message ids are namespaced to the participant.
    const start = events.find((e) => e.type === 'message-start') as { messageId: string };
    expect(start.messageId).toMatch(/^cc-\d+$/);
  });
});

describe('CodexAdapter', () => {
  it('passes configured model and reasoning effort to Codex', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter({ ...codexDescriptor, model: 'gpt-5', effort: 'high' }, transport);
    await agent.start();
    await agent.send('work');
    expect(transport.lastSpawn.spec.args.join(' ')).toContain('--model gpt-5');
    expect(transport.lastSpawn.spec.args).toContain('model_reasoning_effort="high"');
  });

  it('runs `codex exec` for the first turn (prompt via stdin, read-only sandbox)', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter(codexDescriptor, transport);
    await agent.start();
    await agent.send('list the files');

    const { spec, handle } = transport.lastSpawn;
    expect(spec.command).toBe('codex');
    expect(spec.args.slice(0, 2)).toEqual(['exec', '-']);
    expect(spec.args).toContain('--json');
    expect(spec.args.join(' ')).toContain('--sandbox read-only');
    expect(handle.stdinData).toBe('list the files');
    expect(handle.stdinEnded).toBe(true);
  });

  it('captures the thread id and resumes it on the next turn', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter(codexDescriptor, transport);
    const events: AgentEvent[] = [];
    await agent.start();
    agent.onEvent((e) => events.push(e));

    await agent.send('first');
    transport.lastSpawn.handle.emitStdoutLines(fixtureLines('codex-message.jsonl'));
    transport.lastSpawn.handle.close(0);
    await Promise.resolve(); // let the exited handler run

    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { token: string }).token);
    expect(tokens).toContain('hello from codex');

    await agent.send('second');
    const { spec } = transport.lastSpawn;
    expect(spec.args.slice(0, 4)).toEqual(['exec', 'resume', '019ed6fe-480f-7b70-89c2-c6ad2c2a0fc7', '-']);
  });

  it('kills the current process on stop', async () => {
    const transport = new FakeTransport();
    const agent = new CodexAdapter(codexDescriptor, transport);
    await agent.start();
    await agent.send('work');
    await agent.stop();
    expect(transport.lastSpawn.handle.killed).toBe(true);
    expect(agent.status).toBe('stopped');
  });
});
