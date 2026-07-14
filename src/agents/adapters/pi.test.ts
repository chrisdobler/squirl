import { describe, expect, it } from 'vitest';

import { FakeTransport } from '../transport/fake.js';
import { LocalSpawnTransport } from '../transport/local-spawn.js';
import type { AgentDescriptor, AgentEvent } from '../types.js';
import { PiAdapter } from './pi.js';

const descriptor: AgentDescriptor = { id: 'pi', kind: 'pi', label: 'pi', transport: 'local', cwd: '/repo' };

async function startedAgent(overrides: Partial<AgentDescriptor> = {}) {
  const transport = new FakeTransport();
  const agent = new PiAdapter({ ...descriptor, ...overrides }, transport);
  const starting = agent.start();
  await Promise.resolve();
  transport.lastSpawn.handle.emitStdout(JSON.stringify({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', model: { provider: 'openai', id: 'gpt-test' } } }));
  await starting;
  return { agent, transport };
}

describe('PiAdapter', () => {
  it('starts persistent RPC with full coding access by default', async () => {
    const { agent, transport } = await startedAgent({ model: 'openai/gpt-test', effort: 'minimal' });
    expect(transport.lastSpawn.spec).toMatchObject({ command: 'pi', cwd: '/repo' });
    expect(transport.lastSpawn.spec.args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--model', 'openai/gpt-test', '--thinking', 'minimal', '--extension']));
    expect(transport.lastSpawn.spec.env).toMatchObject({ SQUIRL_PI_APPROVAL_MODE: 'acceptEdits' });
    expect(agent.status).toBe('ready');
    expect(agent.descriptor.sessionId).toBe('session-1');
  });

  it('uses the explicit read-only tool allowlist', async () => {
    const { transport } = await startedAgent({ piToolMode: 'read-only', sessionId: 'resume-me' });
    expect(transport.lastSpawn.spec.args).toContain('--session');
    expect(transport.lastSpawn.spec.args.join(' ')).toContain('--tools read,grep,find,ls');
  });

  it('writes prompt, abort, and extension responses as RPC commands', async () => {
    const { agent, transport } = await startedAgent();
    await agent.send('review this');
    await agent.interrupt();
    transport.lastSpawn.handle.emitStdout(JSON.stringify({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Proceed?' }));
    await agent.respondToInteraction('confirm-1', { confirmed: true });
    const commands = transport.lastSpawn.handle.writes.map((line) => JSON.parse(line));
    expect(commands).toContainEqual(expect.objectContaining({ type: 'prompt', message: 'review this' }));
    expect(commands).toContainEqual(expect.objectContaining({ type: 'abort' }));
    expect(commands).toContainEqual({ type: 'extension_ui_response', id: 'confirm-1', confirmed: true });
  });

  it('requests stats at agent_settled and emits usage before turn-end', async () => {
    const { agent, transport } = await startedAgent();
    const events: AgentEvent[] = [];
    agent.onEvent((event) => events.push(event));
    await agent.send('work');
    transport.lastSpawn.handle.emitStdout(JSON.stringify({ type: 'agent_settled' }));
    expect(transport.lastSpawn.handle.writes.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'get_session_stats' }));
    transport.lastSpawn.handle.emitStdout(JSON.stringify({ type: 'response', command: 'get_session_stats', success: true, data: { tokens: { input: 12, output: 3 }, contextUsage: { tokens: 15, contextWindow: 1000 } } }));
    expect(events.map((event) => event.type).slice(-2)).toEqual(['usage', 'turn-end']);
    expect(agent.status).toBe('ready');
  });

  it('reports a missing PI binary without installing or changing the system', async () => {
    const agent = new PiAdapter({ ...descriptor, cwd: process.cwd(), bin: '/definitely/missing/squirl-pi' }, new LocalSpawnTransport());
    await expect(agent.start()).rejects.toThrow('Could not start PI');
  });
});
