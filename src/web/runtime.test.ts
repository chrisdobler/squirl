import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Participant } from '../agents/types.js';

let testHome: string;
let historyDir: string;
let testCounter = 0;
let capturedHistory: any[] = [];
let capturedModel: any = null;
let mockDetectedModels: Array<{ id: string; contextWindow?: number }> = [];
let mockAssistantContent = 'ok';
let preparedHandoffs: Array<{ target: any; originalRequest: string; task: string }> = [];
let mockDelegationClassification = '{"decision":"not_delegate","confidence":"high","targetIds":[],"task":""}';

// Use timestamps relative to "now" so fixture entries stay inside history.ts's 24h
// rollover window regardless of the calendar date the suite runs on (otherwise rollover
// moves them into daily files and re-appends on each load).
const TS_EARLY = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const TS_LATE = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();  // 1h ago

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    get homedir() {
      return () => testHome;
    },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    get homedir() {
      return () => testHome;
    },
  };
});

vi.mock('../orchestrator.js', () => ({
  Orchestrator: class {
    private contextFiles = new Map<string, string>();
    constructor(readonly workingDir: string) {}
    setMemoryPipeline() {}
    setIdentityContext() {}
    getContextFiles() { return new Map(this.contextFiles); }
    getContextSnapshot() { return null; }
    addContextFile(path: string) { this.contextFiles.set(path, 'content'); }
    removeContextFile(path: string) { this.contextFiles.delete(path); }
    clearContextFiles() { this.contextFiles.clear(); }
    async prepareHandoff(target: any, originalRequest: string, task: string) {
      preparedHandoffs.push({ target, originalRequest, task });
      return `Handoff to @${target.id}\n\nGoal: ${task}`;
    }
    async assessFacilitation() { return null; }
    async chat(input: string, conversationHistory: any[], model: any, callbacks: any) {
      capturedHistory = conversationHistory;
      capturedModel = model;
      const user = { id: 'web-user', role: 'user', content: input };
      const assistant = { id: 'web-assistant', role: 'assistant', content: '', isStreaming: true };
      callbacks.onNewMessage(user);
      callbacks.onNewMessage({ ...assistant });
      if (mockAssistantContent) {
        assistant.content = mockAssistantContent;
        callbacks.onToken(mockAssistantContent, { ...assistant });
      }
      assistant.isStreaming = false;
      callbacks.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
      return [user, { ...assistant, content: mockAssistantContent, isStreaming: false }];
    }
  },
}));

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.js')>();
  return {
    ...actual,
    detectLocalBackend: async () => 'vllm' as const,
    fetchAvailableModels: async () => mockDetectedModels,
  };
});

vi.mock('../search/meta-llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../search/meta-llm.js')>();
  return {
    ...actual,
    createConfiguredMetaLLM: () => ({ complete: async () => mockDelegationClassification }),
  };
});

function writeJsonl(filePath: string, entries: Array<{ timestamp: string; message: any }>) {
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

function entry(id: string, role: 'user' | 'assistant', content: string, timestamp: string) {
  return { timestamp, message: { id, role, content } };
}

async function loadRuntime() {
  vi.resetModules();
  capturedHistory = [];
  capturedModel = null;
  preparedHandoffs = [];
  mockDelegationClassification = '{"decision":"not_delegate","confidence":"high","targetIds":[],"task":""}';
  const { SquirlRuntime } = await import('./runtime.js');
  return new SquirlRuntime('/tmp/squirl-web-runtime-test');
}

describe('SquirlRuntime shared history', () => {
  beforeEach(() => {
    testCounter++;
    testHome = join(tmpdir(), `squirl-web-runtime-test-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    }) + '\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('reloads disk history when state is requested after terminal writes', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'before startup', TS_EARLY),
    ]);
    const runtime = await loadRuntime();

    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'before startup', TS_EARLY),
      entry('u2', 'user', 'terminal message', TS_LATE),
    ]);

    expect(runtime.getState().messages.map((message) => message.content)).toContain('terminal message');
  });

  it('routes visual slash commands to typed web command surfaces', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();
    const events: any[] = [];
    await runtime.chat('/settings', 'squirl', (event) => events.push(event));
    expect(events).toContainEqual({ type: 'open-command', surface: 'settings' });
    expect(runtime.getState().commands.find((command) => command.name === 'settings')).toMatchObject({ usage: '/settings', surface: 'settings' });
  });

  it('uses the latest disk history as context for web chat', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'initial', TS_EARLY),
    ]);
    const runtime = await loadRuntime();

    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'initial', TS_EARLY),
      entry('a1', 'assistant', 'terminal reply', TS_LATE),
    ]);

    await runtime.chat('web message', 'squirl', () => {});

    expect(capturedHistory.map((message) => message.content)).toEqual(['initial', 'terminal reply']);
  });

  it('persists completed web assistant replies into shared history', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();

    await runtime.chat('web message', 'squirl', () => {});

    const entries = readFileSync(join(historyDir, 'current.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).message);
    expect(entries.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:web message',
      'assistant:ok',
    ]);
  });

  it('emits absolute assistant updates while streaming', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();
    const events: any[] = [];

    await runtime.chat('web message', 'squirl', (event) => { events.push(event); });

    expect(events).toContainEqual({
      type: 'assistant-update',
      message: { id: 'web-assistant', role: 'assistant', content: 'ok', isStreaming: true, responseMeta: { model: 'claude-sonnet-4-6' } },
    });
  });

  it('persists a clarification question after five minutes without a known task', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();
    const internals = runtime as unknown as {
      taskUnknownSince: number;
      taskRefreshRunning: boolean;
      messages: any[];
      checkTaskClarification: (now: number) => void;
    };
    const now = Date.now();
    internals.taskUnknownSince = now;
    internals.taskRefreshRunning = false;

    internals.checkTaskClarification(now + 5 * 60 * 1000 - 1);
    expect(internals.messages).toHaveLength(0);

    internals.checkTaskClarification(now + 5 * 60 * 1000);
    const prompt = runtime.getState().messages.at(-1);
    expect(prompt).toMatchObject({ role: 'assistant', proactiveKind: 'task-clarification' });
    expect(prompt?.content).toContain('Can you tell me about the current task?');

    internals.checkTaskClarification(now + 60 * 60 * 1000);
    expect(internals.messages.filter((message) => message.proactiveKind === 'task-clarification')).toHaveLength(1);

    const persisted = readFileSync(join(historyDir, 'current.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line).message);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ proactiveKind: 'task-clarification' });
  });

  it('finds a persisted clarification outside the bounded visible transcript', async () => {
    const askedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const entries: Array<{ timestamp: string; message: any }> = [{
      timestamp: askedAt,
      message: { id: 'clarification', role: 'assistant', content: 'What are you working on?', proactiveKind: 'task-clarification', createdAt: askedAt },
    }];
    for (let index = 0; index < 50; index++) {
      const timestamp = new Date(Date.now() - (50 - index) * 60_000).toISOString();
      entries.push(entry(`u${index}`, 'user', `message ${index}`, timestamp));
    }
    writeJsonl(join(historyDir, 'current.jsonl'), entries);

    const runtime = await loadRuntime();
    const internals = runtime as unknown as {
      taskUnknownSince: number;
      taskRefreshRunning: boolean;
      messages: any[];
      checkTaskClarification: (now: number) => void;
    };
    expect(internals.messages).toHaveLength(50);
    expect(internals.messages.some((message) => message.id === 'clarification')).toBe(false);

    internals.taskRefreshRunning = false;
    internals.checkTaskClarification(Date.now() + 24 * 60 * 60_000);

    const persisted = readFileSync(join(historyDir, 'current.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line).message);
    expect(persisted.filter((message) => message.proactiveKind === 'task-clarification')).toHaveLength(1);
  });
});

describe('SquirlRuntime agents', () => {
  beforeEach(() => {
    testCounter++;
    testHome = join(tmpdir(), `squirl-web-runtime-agents-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' }) + '\n', 'utf-8');
    writeJsonl(join(historyDir, 'current.jsonl'), []);
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('exposes user and squirl as participants by default', async () => {
    const runtime = await loadRuntime();
    expect(runtime.getState().participants.map((p) => p.id)).toEqual(['user', 'squirl']);
    expect(runtime.listAgents()).toEqual([]);
  });

  it('adds and removes a codex agent with bounded write access by default', async () => {
    // Codex start() spawns nothing (per-turn model), so no real subprocess is launched here.
    const runtime = await loadRuntime();

    const result = await runtime.addAgent('codex');
    expect(result).toEqual({ ok: true, id: 'codex', label: 'codex' });
    expect(runtime.getState().participants.map((p) => p.id)).toContain('codex');

    const listed = runtime.listAgents();
    expect(listed.map((a) => a.id)).toEqual(['codex']);
    expect(listed[0]!.mode).toBe('sandbox: workspace-write');

    expect(await runtime.stopAgent('codex')).toBe(true);
    expect(runtime.listAgents()).toEqual([]);
    expect(await runtime.stopAgent('codex')).toBe(false);
  });

  it('persists agent failures in the conversation and collapses duplicate error events', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { model: 'gpt-test' });
    const events: any[] = [];
    const internals = runtime as unknown as {
      activeEmit: (event: unknown) => void;
      handleAgentEvent: (event: unknown) => void;
    };
    internals.activeEmit = (event) => events.push(event);

    const failure = { type: 'error', participantId: 'codex', message: 'The selected model requires a newer Codex CLI.' };
    internals.handleAgentEvent(failure);
    internals.handleAgentEvent(failure);

    const errors = runtime.getState().messages.filter((message) => message.role === 'tool' && message.toolStatus === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      toolName: 'codex:connector error',
      content: 'The selected model requires a newer Codex CLI.',
      participantId: 'codex',
    });
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'toast', level: 'error',
      message: 'codex failed. The full error is shown in the conversation.',
    });
  });

  it('launches and persists an agent in the requested working directory', async () => {
    const projectDir = join(testHome, 'Projects', 'demo');
    mkdirSync(projectDir, { recursive: true });
    const runtime = await loadRuntime();

    const result = await runtime.addAgent('codex', { cwd: projectDir });

    expect(result).toEqual({ ok: true, id: 'codex', label: 'codex' });
    expect(runtime.getState().participants.find((participant) => participant.id === 'codex')?.cwd).toBe(projectDir);
    const saved = JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8'));
    expect(saved.agents.defaults[0].cwd).toBe(projectDir);
  });

  it('persists the last completed CLI turn input across runtime recreation', async () => {
    const sessions = join(testHome, '.codex', 'sessions', '2026', '07', '13');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'rollout-session-1.jsonl'), [
      { type: 'session_meta', payload: { base_instructions: 'base rules', context_window: 1000 } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'last injected request' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'completed output must not be counted' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 250 }, model_context_window: 1000 } } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
    const first = await loadRuntime();
    await first.addAgent('codex', { id: 'reviewer', model: 'gpt-test' });
    const firstInternals = first as unknown as {
      coordinator: { contextTelemetry: Map<string, unknown> };
      handleAgentEvent: (event: unknown) => void;
    };
    firstInternals.coordinator.contextTelemetry.set('reviewer', {
      participantId: 'reviewer', sessionId: 'session-1', modelId: 'gpt-test', inputTokens: 250, contextWindow: 1000,
    });
    firstInternals.handleAgentEvent({ type: 'turn-end', participantId: 'reviewer' });
    expect(first.getParticipantContextPreview('reviewer')).toMatchObject({ usedTokens: 250, contextWindow: 1000, matrixMode: 'usage' });

    const second = await loadRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(second.getParticipantContextPreview('reviewer')).toMatchObject({ usedTokens: 250, contextWindow: 1000, matrixMode: 'usage' });
  });

  it('rejects an agent working directory that does not exist', async () => {
    const runtime = await loadRuntime();
    const missingDir = join(testHome, 'missing-project');

    const result = await runtime.addAgent('codex', { cwd: missingDir });

    expect(result).toEqual({ ok: false, error: `Working directory does not exist: ${missingDir}` });
    expect(runtime.listAgents()).toEqual([]);
  });

  it('lists navigable project directories for the folder picker', async () => {
    const projectDir = join(testHome, 'Projects');
    mkdirSync(join(projectDir, 'alpha'), { recursive: true });
    mkdirSync(join(projectDir, 'beta'), { recursive: true });
    mkdirSync(join(projectDir, '.hidden'), { recursive: true });
    const runtime = await loadRuntime();

    expect(runtime.listDirectories(projectDir)).toEqual({
      path: projectDir,
      parent: testHome,
      directories: [
        { name: 'alpha', path: join(projectDir, 'alpha') },
        { name: 'beta', path: join(projectDir, 'beta') },
      ],
    });
  });

  it('persists and renames agent profiles', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex');
    const renamed = await runtime.renameAgent('codex', 'Review Builder');
    expect(renamed).toEqual({ ok: true, id: 'review-builder', label: 'review-builder' });
    expect(runtime.listAgents().map((agent) => agent.id)).toEqual(['review-builder']);
    const saved = JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8'));
    expect(saved.agents.defaults[0]).toMatchObject({ kind: 'codex', id: 'review-builder', reconnect: true });
  });

  it('updates launch settings, preserves profile identity, and clears optional fields', async () => {
    const projectDir = join(testHome, 'Projects', 'edited');
    mkdirSync(projectDir, { recursive: true });
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { model: 'old-model', effort: 'low', sandbox: 'read-only' });
    const before = JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8')).agents.defaults[0];

    const descriptor = (runtime as unknown as { coordinator: { getDescriptor: (id: string) => { sessionId?: string } | undefined } }).coordinator.getDescriptor('codex');
    if (descriptor) descriptor.sessionId = 'old-thread';
    const updated = await runtime.updateAgent('codex', { name: 'Review Builder', model: 'new-model', effort: 'high', cwd: projectDir, sandbox: 'danger-full-access' });

    expect(updated).toEqual({ ok: true, id: 'review-builder', label: 'review-builder' });
    let saved = JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8')).agents.defaults[0];
    expect(saved).toMatchObject({ profileId: before.profileId, id: 'review-builder', model: 'new-model', effort: 'high', cwd: projectDir, sandbox: 'danger-full-access' });
    expect((runtime as unknown as { coordinator: { getDescriptor: (id: string) => { sessionId?: string; sandbox?: string } | undefined } }).coordinator.getDescriptor('review-builder')).toMatchObject({ sandbox: 'danger-full-access', sessionId: undefined });

    expect(await runtime.updateAgent('review-builder', { model: null, effort: null })).toMatchObject({ ok: true, id: 'review-builder' });
    saved = JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8')).agents.defaults[0];
    expect(saved.model).toBeUndefined();
    expect(saved.effort).toBeUndefined();
    expect(saved.profileId).toBe(before.profileId);
  });

  it('rejects duplicate handles, invalid directories, and edits while busy', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'first' });
    await runtime.addAgent('codex', { id: 'second' });

    expect(await runtime.updateAgent('first', { name: 'second' })).toEqual({ ok: false, error: 'Agent "@second" already exists.' });
    const missingDir = join(testHome, 'missing-edit-directory');
    expect(await runtime.updateAgent('first', { cwd: missingDir })).toEqual({ ok: false, error: `Working directory does not exist: ${missingDir}` });

    const internals = runtime as unknown as { coordinator: { agentParticipants: Map<string, Participant> } };
    internals.coordinator.agentParticipants.get('first')!.status = 'busy';
    expect(await runtime.updateAgent('first', { model: 'another-model' })).toEqual({
      ok: false,
      error: 'Cannot edit @first while it is busy. Wait for the current turn to finish or cancel it first.',
    });
  });

  it('invalidates a persisted context preview when launch settings change', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'reviewer', model: 'old-model' });
    const internals = runtime as unknown as { participantContextPreviews: Record<string, any> };
    internals.participantContextPreviews.reviewer = {
      participantId: 'reviewer', modelId: 'old-model', source: 'codex-session', fidelity: 'inspected', matrixMode: 'usage', capturedAt: 'now',
      usedTokens: 10, contextWindow: 100, buckets: { system: 0, memory: 0, files: 0, messages: 10 }, discs: [],
    };

    expect(await runtime.updateAgent('reviewer', { model: 'new-model' })).toMatchObject({ ok: true });
    expect(runtime.getParticipantContextPreview('reviewer')).toMatchObject({ fidelity: 'unavailable', modelId: 'new-model' });
  });

  it('migrates and reconnects saved profiles on startup', async () => {
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      agents: { defaults: [{ kind: 'codex', id: 'codex-builder' }] },
    }) + '\n', 'utf-8');
    const runtime = await loadRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.listAgents().map((agent) => agent.id)).toEqual(['codex-builder']);
    const saved = JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8'));
    expect(saved.agents.defaults[0]).toMatchObject({ id: 'codex-builder', label: 'codex-builder', reconnect: true });
    expect(saved.agents.defaults[0].profileId).toBeTruthy();
  });

  it('recognizes explicit delegation to a saved but disconnected agent', async () => {
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({
      defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6',
      agents: { defaults: [{ kind: 'claude-code', id: 'cc', label: 'cc', reconnect: false }] },
    }) + '\n', 'utf-8');
    const runtime = await loadRuntime();
    const events: any[] = [];
    await runtime.chat('tell cc to make a plan for agent directories', 'squirl', (event) => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'toast', message: expect.stringContaining('@cc is not connected') }));
    expect(capturedHistory).toEqual([]);
    expect(runtime.getState().messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
      'tell cc to make a plan for agent directories',
    ]);
  });

  it('dispatches put-back-on phrasing and immediately records the delegated current task', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"delegate","confidence":"high","targetIds":["codex-squirl"],"task":"the task it was doing before?"}';
    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;

    await runtime.chat('Can you put codex squirrel back on the task it was doing before?', 'squirl', () => undefined);

    expect(preparedHandoffs).toEqual([expect.objectContaining({
      target: expect.objectContaining({ id: 'codex-squirl' }),
      task: 'the task it was doing before?',
    })]);
    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(runtime.getTaskActivityState().tasks[0]).toMatchObject({
      title: 'Resume previous task',
      participantIds: ['codex-squirl'],
    });
  });

  it('persists uncertain delegation and dispatches it exactly once after yes', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"uncertain","confidence":"low","targetIds":["codex-squirl"],"task":"review the overview"}';

    await runtime.chat('Maybe codex squirrel should review the overview', 'squirl', () => undefined);
    expect(runtime.getState().messages.at(-1)).toMatchObject({
      role: 'assistant', proactiveKind: 'delegation-confirmation',
      delegationConfirmation: { targetIds: ['codex-squirl'], task: 'review the overview' },
    });

    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    await runtime.chat('yes', 'squirl', () => undefined);
    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(preparedHandoffs.at(-1)).toMatchObject({ task: 'review the overview' });
  });

  it('cancels an uncertain delegation after no', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"uncertain","confidence":"low","targetIds":["codex-squirl"],"task":"review this"}';
    await runtime.chat('Maybe codex squirrel should review this', 'squirl', () => undefined);

    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    await runtime.chat('no', 'squirl', () => undefined);
    expect(dispatchTo).not.toHaveBeenCalled();
    expect(runtime.getState().messages.at(-1)?.content).toBe('Okay, I won’t dispatch that work.');
  });

  it('recovers an unexpired delegation confirmation after restart', async () => {
    const first = await loadRuntime();
    await first.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"uncertain","confidence":"low","targetIds":["codex-squirl"],"task":"resume work"}';
    await first.chat('Maybe codex squirrel should resume work', 'squirl', () => undefined);

    const second = await loadRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const dispatchTo = vi.fn(async () => undefined);
    (second as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    await second.chat('yes', 'squirl', () => undefined);
    expect(dispatchTo).toHaveBeenCalledOnce();
  });

  it('records direct agent assignments and advances them on that agent response', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    const dispatchTo = vi.fn(async () => undefined);
    const internals = runtime as unknown as {
      coordinator: { dispatchTo: typeof dispatchTo };
      handleAgentEvent: (event: unknown) => void;
    };
    internals.coordinator.dispatchTo = dispatchTo;

    await runtime.chat('Move local LLM infrastructure outside the Squirl box', 'codex-squirl', () => undefined);
    const assigned = runtime.getTaskActivityState().tasks[0]!;
    expect(assigned).toMatchObject({ title: 'Move local LLM infrastructure outside the Squirl box', participantIds: ['codex-squirl'] });

    internals.handleAgentEvent({ type: 'message-start', participantId: 'codex-squirl', messageId: 'agent-update' });
    internals.handleAgentEvent({ type: 'message-end', participantId: 'codex-squirl', messageId: 'agent-update', content: 'Working on the overview now.' });
    const advanced = runtime.getTaskActivityState().tasks[0]!;
    expect(Date.parse(advanced.lastActiveAt)).toBeGreaterThanOrEqual(Date.parse(assigned.lastActiveAt));
    expect(advanced.evidenceIds).toContain('agent-update');
  });

  it('keeps a durable stale snapshot when refresh is unavailable and expires it only after a reliable refresh', async () => {
    writeFileSync(join(testHome, '.squirl', 'task-activity.json'), JSON.stringify({
      version: 1,
      generatedAt: '2026-07-13T16:00:00.000Z',
      sourceWatermark: 'old',
      tasks: [{ id: 'task-1', title: 'Previous reliable task', lastActiveAt: '2026-07-13T16:30:00.000Z', participantIds: ['codex'], evidenceIds: ['u1'] }],
    }), 'utf-8');
    const runtime = await loadRuntime();
    const internals = runtime as unknown as { taskRefreshFailed: boolean; taskSourceDirty: boolean; taskRefreshRunning: boolean };
    internals.taskRefreshRunning = false;
    internals.taskRefreshFailed = true;
    internals.taskSourceDirty = true;
    expect(runtime.getTaskActivityState(Date.parse('2026-07-13T18:00:00.000Z'))).toMatchObject({ status: 'stale', tasks: [{ title: 'Previous reliable task' }] });

    internals.taskRefreshFailed = false;
    internals.taskSourceDirty = false;
    expect(runtime.getTaskActivityState(Date.parse('2026-07-13T18:00:00.000Z'))).toMatchObject({ status: 'ready', tasks: [] });
  });

  it('coalesces task refreshes and emits a streamed task snapshot', async () => {
    const recent = new Date().toISOString();
    writeJsonl(join(historyDir, 'current.jsonl'), [entry('task-user', 'user', 'build inferred task activity', recent)]);
    const runtime = await loadRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    let classifications = 0;
    const events: any[] = [];
    const internals = runtime as unknown as {
      config: any;
      embedder: any;
      vectorStore: any;
      taskMetaLLM: any;
      taskActivityEmit: (event: any) => void;
      markTaskActivityChanged: () => void;
    };
    internals.config.index = { enabled: true, store: 'null', embedder: 'local', recallK: 4 };
    internals.embedder = { name: 'fake', dimensions: 1, embed: async () => [[1]] };
    internals.vectorStore = { query: async () => [{
      id: 'memory-1', score: 1,
      turnPair: { id: 'memory-1', source: 'squirl', conversationId: 'history', timestamp: recent, userText: 'task activity', assistantText: 'sidebar' },
    }] };
    internals.taskMetaLLM = { complete: async () => {
      classifications += 1;
      return JSON.stringify({ confidence: 'high', tasks: [{ title: 'Build inferred task activity', summary: 'The runtime is classifying recent work into a sidebar task feed.', evidenceIds: ['task-user'] }] });
    } };
    internals.taskActivityEmit = (event) => events.push(event);
    internals.markTaskActivityChanged();
    internals.markTaskActivityChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(classifications).toBe(1);
    expect(runtime.getTaskActivityState()).toMatchObject({ status: 'ready', tasks: [{ title: 'Build inferred task activity' }] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'task-activity', taskActivity: expect.objectContaining({ status: 'ready' }) }));
  });
});

describe('SquirlRuntime context window', () => {
  const localModel = {
    id: 'llama-local',
    label: 'llama-local',
    provider: 'local' as const,
    baseUrl: 'http://gateway/v1',
    backend: 'vllm' as const,
  };

  beforeEach(() => {
    testCounter++;
    testHome = join(tmpdir(), `squirl-web-ctxwin-${process.pid}-${testCounter}`);
    mkdirSync(join(testHome, '.squirl'), { recursive: true });
    mockDetectedModels = [];
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    mockDetectedModels = [];
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify(config) + '\n', 'utf-8');
  }

  function readSavedConfig(): any {
    return JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8'));
  }

  it('shows the curated window for a known cloud model', async () => {
    writeConfig({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' });
    const runtime = await loadRuntime();
    expect(runtime.getStatus().contextWindow).toBe(200_000);
  });

  it('reports null when a local model window is unknown so the UI can show "?"', async () => {
    writeConfig({ defaultProvider: 'local', defaultModel: localModel.id, localBaseUrl: localModel.baseUrl, localBackend: 'vllm' });
    mockDetectedModels = [{ id: localModel.id }]; // gateway advertises no window
    const runtime = await loadRuntime();
    await runtime.selectModel(localModel);
    expect(runtime.getStatus().contextWindow).toBeNull();
  });

  it('persists a discovered local window so it survives a restart', async () => {
    writeConfig({ defaultProvider: 'local', defaultModel: localModel.id, localBaseUrl: localModel.baseUrl, localBackend: 'vllm' });
    mockDetectedModels = [{ id: localModel.id, contextWindow: 32_768 }];
    const runtime = await loadRuntime();
    await runtime.selectModel(localModel);

    expect(runtime.getStatus().contextWindow).toBe(32_768);
    expect(readSavedConfig().modelContextWindows?.[localModel.id]).toBe(32_768);

    // Restart with the gateway no longer advertising a window: the persisted value is used.
    mockDetectedModels = [{ id: localModel.id }];
    const restarted = await loadRuntime();
    expect(restarted.getStatus().contextWindow).toBe(32_768);
    await restarted.chat('use the persisted window', 'squirl', () => {});
    expect(capturedModel.contextWindow).toBe(32_768);
  });

  it('keeps an explicitly selected local model across a state poll (no config-churn reset)', async () => {
    // Default provider is hosted, but the user picks a local model in the Models panel. Persisting
    // its window must not let the 1.5s /api/state poll revert the selection to the hosted default.
    writeConfig({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' });
    mockDetectedModels = [{ id: localModel.id, contextWindow: 32_768 }];
    const runtime = await loadRuntime();
    await runtime.selectModel(localModel);
    expect(runtime.getStatus().selectedModel.provider).toBe('local');

    // Simulate two periodic polls (each calls getState → refreshConfigFromDisk).
    runtime.getState();
    runtime.getState();

    expect(runtime.getStatus().selectedModel.id).toBe(localModel.id);
    expect(runtime.getStatus().selectedModel.provider).toBe('local');
    expect(runtime.getStatus().contextWindow).toBe(32_768);
  });

  it('exposes a context breakdown that grows when a file is attached', async () => {
    writeConfig({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' });
    const runtime = await loadRuntime();

    const before = runtime.getStatus().contextBreakdown;
    expect(before.system).toBeGreaterThan(0); // the system prompt always contributes
    expect(before.files).toBe(0);

    runtime.addContextFile('src/foo.ts');
    const after = runtime.getStatus().contextBreakdown;
    expect(after.files).toBeGreaterThan(0);
    expect(after.system).toBe(before.system);
    // tokenCount is the breakdown sum plus a per-message overhead.
    const { system, files, messages } = after;
    expect(runtime.getStatus().tokenCount).toBe(system + files + messages);
  });
});

describe('SquirlRuntime empty responses', () => {
  beforeEach(() => {
    testCounter++;
    testHome = join(tmpdir(), `squirl-web-empty-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' }) + '\n', 'utf-8');
    writeJsonl(join(historyDir, 'current.jsonl'), []);
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    mockAssistantContent = 'ok';
  });

  it('surfaces a toast when the model returns an empty reply', async () => {
    mockAssistantContent = '';
    const runtime = await loadRuntime();
    const events: any[] = [];

    await runtime.chat('hello', 'squirl', (event) => { events.push(event); });

    expect(events).toContainEqual({ type: 'toast', level: 'error', message: 'The model returned an empty response.' });
  });

  it('does not toast when the model returns content', async () => {
    mockAssistantContent = 'ok';
    const runtime = await loadRuntime();
    const events: any[] = [];

    await runtime.chat('hello', 'squirl', (event) => { events.push(event); });

    expect(events.some((e) => e.type === 'toast')).toBe(false);
    expect(events.find((e) => e.type === 'assistant-final')?.message.responseMeta).toEqual({ model: 'claude-sonnet-4-6' });
  });
});
