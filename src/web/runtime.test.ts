import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Participant } from '../agents/types.js';
import { MemoryRoomStore } from '../persistence/memory-room-store.js';

let testHome: string;
let historyDir: string;
let testCounter = 0;
let capturedHistory: any[] = [];
let capturedModel: any = null;
let mockDetectedModels: Array<{ id: string; contextWindow?: number }> = [];
let mockAssistantContent = 'ok';
let preparedHandoffs: Array<{ target: any; originalRequest: string; task: string }> = [];
let mockDelegationClassification = '{"decision":"not_delegate","confidence":"high","targetIds":[],"task":""}';
let mockActionDecision: any = { type: 'respond' };
let mockAnswerAssessment: any = { confidence: 90 };
let mockCodexBin = '';
let mockContextSnapshot: any = null;
let beforeAssistantToken: (() => void | Promise<void>) | null = null;
let mockResearchEvidence: any = null;
let capturedAssessmentResearch: any = null;
let answerAssessmentImplementation: ((...args: any[]) => Promise<any>) | null = null;

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
    getLatestContextSnapshot() { return mockContextSnapshot; }
    getContextSnapshot() { return mockContextSnapshot; }
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
      await callbacks.onNewMessage({ ...assistant });
      if (mockResearchEvidence) await callbacks.onNewMessage(mockResearchEvidence);
      await beforeAssistantToken?.();
      if (mockAssistantContent) {
        assistant.content = mockAssistantContent;
        callbacks.onToken(mockAssistantContent, { ...assistant });
      }
      assistant.isStreaming = false;
      await callbacks.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, { ...assistant });
      return [user, ...(mockResearchEvidence ? [mockResearchEvidence] : []), { ...assistant, content: mockAssistantContent, isStreaming: false }];
    }
  },
}));

beforeEach(() => { mockContextSnapshot = null; });

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
    createConfiguredTaskMetaLLM: () => ({ complete: async () => mockDelegationClassification }),
  };
});

vi.mock('../agents/action-model.js', () => ({
  probeModelActionCapabilities: async () => ({ nativeToolCalls: false, structuredOutput: true }),
  decideSquirlAction: async () => mockActionDecision,
}));

vi.mock('../agents/answer-assessment.js', () => ({
  HANDOFF_CONFIDENCE_THRESHOLD: 80,
  assessSquirlAnswer: async (...args: any[]) => {
    capturedAssessmentResearch = args[4];
    return answerAssessmentImplementation ? answerAssessmentImplementation(...args) : mockAnswerAssessment;
  },
}));

vi.mock('../agents/codex-models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/codex-models.js')>();
  return { ...actual, resolveCodexBinary: () => mockCodexBin || actual.resolveCodexBinary() };
});

function installFakeCodex(): void {
  mockCodexBin = join(testHome, 'fake-codex.cjs');
  writeFileSync(mockCodexBin, `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'session-1' }, model: message.params.model || 'gpt-test' } });
  else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId }, model: message.params.model || 'gpt-test' } });
  else if (message.method === 'turn/start') { send({ id: message.id, result: { turn: { id: 'turn-1' } } }); send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-1' } } }); }
  else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
});
`);
  chmodSync(mockCodexBin, 0o755);
}

function writeJsonl(filePath: string, entries: Array<{ timestamp: string; message: any }>) {
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

function entry(id: string, role: 'user' | 'assistant', content: string, timestamp: string) {
  return { timestamp, message: { id, role, content } };
}

async function loadRuntime(roomStore?: MemoryRoomStore) {
  vi.resetModules();
  capturedHistory = [];
  capturedModel = null;
  preparedHandoffs = [];
  mockDelegationClassification = '{"decision":"not_delegate","confidence":"high","targetIds":[],"task":""}';
  mockActionDecision = { type: 'respond' };
  mockAnswerAssessment = { confidence: 90 };
  beforeAssistantToken = null;
  mockResearchEvidence = null;
  capturedAssessmentResearch = null;
  answerAssessmentImplementation = null;
  mkdirSync('/tmp/squirl-web-runtime-test', { recursive: true });
  const { SquirlRuntime } = await import('./runtime.js');
  return new SquirlRuntime('/tmp/squirl-web-runtime-test', roomStore);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous runtime state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  it.each([
    [true, 'allowed', true],
    [false, 'denied', false],
  ] as const)('persists first-use web research consent when approval is %s', async (approved, consent, enabled) => {
    const runtime = await loadRuntime();
    let resolved: boolean | undefined;
    (runtime as any).pendingApprovals.set('research-consent', {
      request: { id: 'research-consent', toolName: 'web_search', command: 'California BIC EBT current guidance' },
      resolve: (value: boolean) => { resolved = value; },
    });

    expect(runtime.approveToolRequest('research-consent', approved)).toBe(true);
    expect(resolved).toBe(approved);
    expect(runtime.getState().config.research).toMatchObject({ consent, enabled, mode: 'automatic', maxResults: 5 });
    expect(JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8')).research).toMatchObject({ consent, enabled });
  });

  it('does not create memory chunks when their exact source message write failed', async () => {
    const roomStore = new MemoryRoomStore();
    const runtime = await loadRuntime(roomStore);
    await runtime.ready();
    const insert = vi.spyOn(roomStore, 'insertMessage')
      .mockRejectedValueOnce(new Error('postgres offline'))
      .mockResolvedValueOnce(undefined);
    const replace = vi.spyOn(roomStore, 'replaceMemoryChunks').mockResolvedValue(undefined);
    const internals = runtime as unknown as {
      config: { index?: { enabled: boolean } };
      persistMessage: (message: { id: string; role: 'user'; content: string }) => Promise<void>;
      memoryPersistenceTail: Promise<void>;
    };
    internals.config.index = { enabled: true };

    const failed = internals.persistMessage({ id: 'failed-source', role: 'user', content: 'not durable' });
    const succeeded = internals.persistMessage({ id: 'durable-source', role: 'user', content: 'durable' });

    await expect(failed).rejects.toThrow('postgres offline');
    await expect(succeeded).resolves.toBeUndefined();
    await internals.memoryPersistenceTail;
    expect(insert).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalledWith('failed-source', expect.anything());
    expect(replace).toHaveBeenCalledWith('durable-source', expect.anything());
    await runtime.shutdown();
  });

  it('keeps routine active and queued assignment cards collapsed', async () => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as unknown as {
      createTurnActivity: (turn: { id: string; participantId: string; input: string; enqueuedAt: string }, started: boolean) => void;
      syncWorkActivities: (work: {
        active: Array<{ participantId: string; turnId: string; phase: 'preparing'; queueDepth: number; cancellable: boolean }>;
        queued: Array<{ id: string; participantId: string; input: string; enqueuedAt: string }>;
        interrupted: never[];
        failed: never[];
      }) => void;
    };
    const active = { id: 'turn-active', participantId: 'squirl', input: 'hello', enqueuedAt: TS_EARLY };
    const queued = { id: 'turn-queued', participantId: 'squirl', input: 'next', enqueuedAt: TS_LATE };
    internals.createTurnActivity(active, true);
    internals.createTurnActivity(queued, false);
    internals.syncWorkActivities({
      active: [{ participantId: 'squirl', turnId: active.id, phase: 'preparing', queueDepth: 1, cancellable: true }],
      queued: [queued], interrupted: [], failed: [],
    });

    const cards = runtime.getState().messages.filter((message) => message.role === 'activity');
    expect(cards).toHaveLength(2);
    expect(cards.every((message) => message.role === 'activity' && message.activity.collapsed)).toBe(true);
  });

  it.each([
    ['interrupted', 'stalled'],
    ['failed', 'failed'],
  ] as const)('keeps the generic %s turn activity routine so recovery has one card', async (collection, state) => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as unknown as {
      createTurnActivity: (turn: { id: string; participantId: string; input: string; enqueuedAt: string }, started: boolean) => void;
      syncWorkActivities: (work: {
        active: never[]; queued: never[];
        interrupted: Array<{ id: string; participantId: string; input: string; enqueuedAt: string; lastError: string }>;
        failed: Array<{ id: string; participantId: string; input: string; enqueuedAt: string; lastError: string }>;
      }) => void;
    };
    const turn = { id: `turn-${collection}`, participantId: 'squirl', input: 'hello', enqueuedAt: TS_EARLY, lastError: 'Server restarted' };
    internals.createTurnActivity(turn, true);
    internals.syncWorkActivities({
      active: [], queued: [],
      interrupted: collection === 'interrupted' ? [turn] : [],
      failed: collection === 'failed' ? [turn] : [],
    });

    const card = runtime.getState().messages.find((message) => message.id === `activity-turn-${turn.id}`);
    expect(card).toMatchObject({
      role: 'activity',
      activity: { kind: 'assignment', state, actions: [], collapsed: true },
    });
  });

  it('adopts a previously launched Claude workflow as a durable research activity on startup', async () => {
    const launchNarrative = 'The deep-research workflow is now running in the background (task `wd8ujffoh`). It will use multiple research agents.';
    writeJsonl(join(historyDir, 'current.jsonl'), [
      { timestamp: TS_EARLY, message: { id: 'workflow-narrative', role: 'assistant', participantId: 'cc-squirl-fable', content: launchNarrative } },
      { timestamp: TS_LATE, message: {
        id: 'workflow-tool', role: 'tool', toolCallId: 'workflow-1', toolName: 'cc-squirl-fable:Workflow',
        participantId: 'cc-squirl-fable', toolStatus: 'success',
        content: [
          'Workflow launched in background. Task ID: wd8ujffoh',
          'Run ID: wf_639dee03-5ac',
          'Summary: Deep research on durable activity cards',
        ].join('\n'),
      } },
    ]);
    const runtime = await loadRuntime();
    await runtime.ready();

    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      id: 'activity-job-cc-squirl-fable-wd8ujffoh', role: 'activity', participantId: 'cc-squirl-fable',
      activity: expect.objectContaining({
        kind: 'research', state: 'running', actions: ['check-status'], detail: launchNarrative,
        provider: expect.objectContaining({ taskId: 'wd8ujffoh', runId: 'wf_639dee03-5ac', workflowName: 'deep-research' }),
      }),
    }));
  });

  it('adopts a live Workflow tool result when structured async metadata is absent', async () => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as unknown as { handleAgentEvent: (event: unknown) => void };
    internals.handleAgentEvent({ type: 'tool-start', participantId: 'cc-squirl-fable', toolId: 'workflow-live', toolName: 'Workflow', input: {} });
    internals.handleAgentEvent({
      type: 'tool-end', participantId: 'cc-squirl-fable', toolId: 'workflow-live', toolName: 'Workflow', ok: true,
      result: [
        'Workflow launched in background. Task ID: task-live',
        'Summary: Deep research on voice options',
        'Transcript dir: /tmp/workflows/wf-live',
        'Script file: /tmp/scripts/deep-research-wf-live.js',
        'Run ID: wf-live',
      ].join('\n'),
    });
    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      id: 'activity-job-cc-squirl-fable-task-live', role: 'activity',
      activity: expect.objectContaining({
        kind: 'research', state: 'running', actions: ['check-status'],
        provider: expect.objectContaining({ taskId: 'task-live', runId: 'wf-live', scriptPath: '/tmp/scripts/deep-research-wf-live.js' }),
      }),
    }));
  });

  it('settles a completed Claude result card from the provider-native final response', async () => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as unknown as { handleAgentEvent: (event: unknown) => void };
    internals.handleAgentEvent({
      type: 'background-job', participantId: 'cc-squirl-fable', state: 'started',
      taskId: 'task-native', runId: 'wf-native', workflowName: 'deep-research',
    });
    internals.handleAgentEvent({
      type: 'background-job', participantId: 'cc-squirl-fable', state: 'completed', taskId: 'task-native',
    });
    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      id: 'activity-job-cc-squirl-fable-task-native-result',
      activity: expect.objectContaining({ state: 'waiting', phase: 'Preparing final response' }),
    }));

    internals.handleAgentEvent({ type: 'message-start', participantId: 'cc-squirl-fable', messageId: 'native-report' });
    internals.handleAgentEvent({
      type: 'message-end', participantId: 'cc-squirl-fable', messageId: 'native-report',
      content: 'The provider-native final research report.',
    });
    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      id: 'activity-job-cc-squirl-fable-task-native-result',
      activity: expect.objectContaining({ state: 'waiting' }),
    }));
    internals.handleAgentEvent({ type: 'turn-end', participantId: 'cc-squirl-fable' });

    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      id: 'activity-job-cc-squirl-fable-task-native-result',
      activity: expect.objectContaining({ state: 'succeeded', phase: 'Final response posted', collapsed: true }),
    }));
  });

  it('does not mistake interim text before a tool call for the final research response', async () => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as unknown as { handleAgentEvent: (event: unknown) => void };
    internals.handleAgentEvent({
      type: 'background-job', participantId: 'cc-squirl-fable', state: 'started',
      taskId: 'task-interim', runId: 'wf-interim', workflowName: 'deep-research',
    });
    internals.handleAgentEvent({
      type: 'background-job', participantId: 'cc-squirl-fable', state: 'completed', taskId: 'task-interim',
    });
    internals.handleAgentEvent({ type: 'message-start', participantId: 'cc-squirl-fable', messageId: 'interim' });
    internals.handleAgentEvent({
      type: 'message-end', participantId: 'cc-squirl-fable', messageId: 'interim',
      content: 'Let me inspect the workflow output.',
    });
    internals.handleAgentEvent({
      type: 'tool-start', participantId: 'cc-squirl-fable', toolId: 'read-result', toolName: 'Bash', input: {},
    });
    internals.handleAgentEvent({ type: 'turn-end', participantId: 'cc-squirl-fable' });

    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      id: 'activity-job-cc-squirl-fable-task-interim-result',
      activity: expect.objectContaining({ state: 'waiting', phase: 'Preparing final response' }),
    }));
  });

  it('loads the authoritative completed result for a tool-free handback and finalizes journal progress', async () => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const sessionDir = join(testHome, 'provider-session');
    const transcriptDir = join(sessionDir, 'subagents', 'workflows', 'wf-result');
    const outputPath = join(testHome, 'task-result.json');
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify({ result: { summary: 'Verified result', findings: [{ claim: 'A' }] } }));
    writeFileSync(`${sessionDir}.jsonl`, [
      JSON.stringify({
        content: `<task-notification><task-id>task-result</task-id><output-file>${outputPath}</output-file><status>completed</status></task-notification>`,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me inspect the result.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The final provider report.' }] },
      }),
    ].join('\n') + '\n');
    writeFileSync(join(transcriptDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'one', agentId: 'a1' }),
      JSON.stringify({ type: 'result', key: 'one', agentId: 'a1', result: { summary: 'Verified result' } }),
    ].join('\n') + '\n');
    const card = {
      version: 1, kind: 'research', state: 'succeeded', title: 'Research complete',
      participantId: 'cc-squirl-fable', startedAt: TS_EARLY, updatedAt: TS_LATE,
      actions: [], collapsed: true,
      progress: { completed: 0, active: 1, phase: 'Background workflow' },
      provider: { kind: 'claude-code', taskId: 'task-result', transcriptDir },
    } as any;
    const privateRuntime = runtime as unknown as {
      workflowResultForHandback: (card: any) => unknown;
      completedWorkflowProgress: (card: any) => unknown;
      workflowNativeHandbackText: (card: any) => string | null;
      backgroundSynthesisPrompt: (source: any) => string;
    };

    expect(privateRuntime.workflowResultForHandback(card)).toEqual({
      summary: 'Verified result', findings: [{ claim: 'A' }],
    });
    expect(privateRuntime.completedWorkflowProgress(card)).toEqual({
      completed: 1, active: undefined, unfinished: undefined, phase: 'Background workflow',
    });
    expect(privateRuntime.workflowNativeHandbackText(card)).toBe('The final provider report.');
    const prompt = privateRuntime.backgroundSynthesisPrompt({ id: 'source', role: 'activity', content: '', activity: card });
    expect(prompt).toContain('<authoritative-workflow-result>');
    expect(prompt).toContain('"summary":"Verified result"');
    expect(prompt).toContain('Do not call tools');
  });

  it('retires failed recovery turns after their source activity succeeds', async () => {
    const runtime = await loadRuntime();
    await runtime.ready();
    const removeQueued = vi.fn(async (_turnId: string) => true);
    const internals = runtime as unknown as {
      workState: any;
      turnScheduler: { removeQueued: typeof removeQueued };
      dismissSupersededBackgroundTurns: (sourceActivityId: string) => Promise<void>;
    };
    internals.workState = {
      active: [], queued: [],
      interrupted: [{ id: 'interrupted-match', metadata: { sourceActivityId: 'source-1' } }],
      failed: [
        { id: 'failed-match', metadata: { sourceActivityId: 'source-1' } },
        { id: 'failed-unrelated', metadata: { sourceActivityId: 'source-2' } },
      ],
    };
    internals.turnScheduler.removeQueued = removeQueued;

    await internals.dismissSupersededBackgroundTurns('source-1');

    expect(removeQueued.mock.calls.map(([id]) => id)).toEqual(['interrupted-match', 'failed-match']);
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
    expect(entries[0]).toMatchObject({ role: 'user', content: 'web message' });
    expect(entries.slice(1)).not.toHaveLength(0);
    expect(entries.slice(1).every((message) => message.role === 'assistant' && message.content === 'ok')).toBe(true);
    const materialized = [...new Map(entries.map((message) => [message.id, message])).values()];
    expect(materialized.map((message) => `${message.role}:${message.content}`)).toEqual(['user:web message', 'assistant:ok']);
  });

  it('durably inserts the assistant shell before the first streamed token', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const store = new MemoryRoomStore();
    const runtime = await loadRuntime(store);
    beforeAssistantToken = async () => {
      const assistant = (await store.loadMessages()).find((item) => item.message.role === 'assistant');
      expect(assistant?.message).toMatchObject({ content: '', isStreaming: true });
      expect(assistant?.turnId).toBeTruthy();
    };

    await runtime.chat('web message', 'squirl', () => {});

    const assistant = (await store.loadMessages()).find((item) => item.message.role === 'assistant');
    expect(assistant?.message).toMatchObject({ content: 'ok', isStreaming: false, responseState: 'complete' });
  });

  it('fails the turn when the final assistant update is not durable', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const store = new MemoryRoomStore();
    const runtime = await loadRuntime(store);
    beforeAssistantToken = () => {
      store.updateMessage = async () => { throw new Error('final persistence unavailable'); };
    };

    await expect(runtime.chat('web message', 'squirl', () => {})).rejects.toThrow('final persistence unavailable');

    expect(runtime.getState().work.failed).toContainEqual(expect.objectContaining({
      input: 'web message', lastError: 'final persistence unavailable',
    }));
    expect((await store.loadMessages()).find((item) => item.message.role === 'assistant')?.message).toMatchObject({
      content: '', isStreaming: true,
    });
  });

  it('recovers a durable partial response after its turn is interrupted', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const store = new MemoryRoomStore();
    await store.initialize();
    const queued = await store.enqueue({ participantId: 'squirl', input: 'explain STT', requestId: 'interrupted-request' });
    const claimed = await store.claim('old-worker', 30_000);
    expect(claimed?.id).toBe(queued.turn.id);
    await store.insertMessage({
      id: 'partial-assistant', role: 'assistant', content: 'STT converts speech', isStreaming: true,
      responseMeta: { model: 'local' },
    }, queued.turn.id);
    await store.finish(queued.turn.id, 'old-worker', 'failed', 'The server restarted while this turn was active.');

    const runtime = await loadRuntime(store);
    await runtime.ready();

    expect(runtime.getState().messages.find((message) => message.id === 'partial-assistant')).toMatchObject({
      content: 'STT converts speech', isStreaming: false, responseState: 'interrupted',
    });
    expect((await store.loadMessages()).find((item) => item.message.id === 'partial-assistant')?.message).toMatchObject({
      content: 'STT converts speech', isStreaming: false, responseState: 'interrupted',
    });
    expect(runtime.getState().work.failed).toContainEqual(expect.objectContaining({ id: queued.turn.id }));
  });

  it('replaces an interrupted empty shell with a durable explanation', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const store = new MemoryRoomStore();
    await store.initialize();
    const queued = await store.enqueue({ participantId: 'squirl', input: 'hello', requestId: 'empty-interrupted-request' });
    await store.claim('old-worker', 30_000);
    await store.insertMessage({ id: 'empty-assistant', role: 'assistant', content: '', isStreaming: true }, queued.turn.id);
    await store.finish(queued.turn.id, 'old-worker', 'failed', 'Model connection lost.');

    const runtime = await loadRuntime(store);
    await runtime.ready();

    expect(runtime.getState().messages.find((message) => message.id === 'empty-assistant')).toMatchObject({
      content: 'Response interrupted before generating text.', isStreaming: false, responseState: 'interrupted',
    });
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
    await runtime.ready();
    const internals = runtime as unknown as {
      taskClarificationState: { phase: string; unknownSince: number | null };
      taskClarificationHydrated: boolean;
      taskRefreshRunning: boolean;
      taskRefreshQueued: boolean;
      taskRefreshScheduled: boolean;
      taskRefreshFailed: boolean;
      taskSourceDirty: boolean;
      calendarRefreshRunning: boolean;
      calendarRefreshQueued: boolean;
      calendarRefreshFailed: boolean;
      messages: any[];
      checkTaskClarification: (now: number) => void;
    };
    const now = Date.now();
    internals.taskClarificationState = { phase: 'unknown-unasked', unknownSince: now };
    internals.taskClarificationHydrated = true;
    internals.taskRefreshRunning = false;
    internals.taskRefreshQueued = false;
    internals.taskRefreshScheduled = false;
    internals.taskRefreshFailed = false;
    internals.taskSourceDirty = false;
    internals.calendarRefreshRunning = false;
    internals.calendarRefreshQueued = false;
    internals.calendarRefreshFailed = false;

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
    await runtime.ready();
    const internals = runtime as unknown as {
      taskClarificationState: { phase: string; unknownSince: number | null };
      taskRefreshRunning: boolean;
      taskRefreshQueued: boolean;
      taskRefreshScheduled: boolean;
      taskRefreshFailed: boolean;
      taskSourceDirty: boolean;
      calendarRefreshRunning: boolean;
      calendarRefreshQueued: boolean;
      calendarRefreshFailed: boolean;
      messages: any[];
      checkTaskClarification: (now: number) => void;
    };
    expect(internals.messages).toHaveLength(50);
    expect(internals.messages.some((message) => message.id === 'clarification')).toBe(false);

    internals.taskRefreshRunning = false;
    internals.taskRefreshQueued = false;
    internals.taskRefreshScheduled = false;
    internals.taskRefreshFailed = false;
    internals.taskSourceDirty = false;
    internals.calendarRefreshRunning = false;
    internals.calendarRefreshQueued = false;
    internals.calendarRefreshFailed = false;
    internals.checkTaskClarification(Date.now() + 24 * 60 * 60_000);

    const persisted = readFileSync(join(historyDir, 'current.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line).message);
    expect(persisted.filter((message) => message.proactiveKind === 'task-clarification')).toHaveLength(1);
    expect(internals.taskClarificationState.phase).toBe('unknown-asked');
  });

  it('does not ask while new task evidence is awaiting classification or a refresh has failed', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as any;
    const now = Date.now();
    internals.taskClarificationHydrated = true;
    internals.taskClarificationState = { phase: 'unknown-unasked', unknownSince: now - 10 * 60_000 };
    internals.taskRefreshRunning = false;
    internals.taskRefreshQueued = false;
    internals.taskRefreshScheduled = false;
    internals.taskRefreshFailed = false;
    internals.taskSourceDirty = true;
    internals.calendarRefreshRunning = false;
    internals.calendarRefreshQueued = false;
    internals.calendarRefreshFailed = false;

    internals.checkTaskClarification(now);

    expect(internals.messages.filter((message: any) => message.proactiveKind === 'task-clarification')).toHaveLength(0);
    expect(internals.taskClarificationState.phase).toBe('unknown-unasked');

    internals.taskSourceDirty = false;
    internals.taskRefreshFailed = true;
    internals.checkTaskClarification(now + 60_000);

    expect(internals.messages.filter((message: any) => message.proactiveKind === 'task-clarification')).toHaveLength(0);
    expect(internals.taskClarificationState.phase).toBe('unknown-unasked');
  });

  it('asks again only after confirmed awareness is lost for five minutes', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();
    await runtime.ready();
    const internals = runtime as any;
    const now = Date.now();
    internals.taskClarificationHydrated = true;
    internals.taskClarificationState = { phase: 'unknown-asked', unknownSince: now - 30 * 60_000 };
    internals.taskRefreshRunning = false;
    internals.taskRefreshQueued = false;
    internals.taskRefreshScheduled = false;
    internals.taskRefreshFailed = false;
    internals.taskSourceDirty = false;
    internals.calendarRefreshRunning = false;
    internals.calendarRefreshQueued = false;
    internals.calendarRefreshFailed = false;
    internals.taskActivitySnapshot = {
      version: 3,
      generatedAt: new Date(now).toISOString(),
      sourceWatermark: 'known',
      tasks: [{ id: 't1', title: 'Known work', lastActiveAt: new Date(now - 60 * 60_000).toISOString(), participantIds: [], evidenceIds: [] }],
    };

    internals.checkTaskClarification(now);
    expect(internals.taskClarificationState.phase).toBe('known');

    internals.checkTaskClarification(now + 1);
    expect(internals.taskClarificationState).toEqual({ phase: 'unknown-unasked', unknownSince: now });
    internals.checkTaskClarification(now + 5 * 60_000 - 1);
    expect(internals.messages.filter((message: any) => message.proactiveKind === 'task-clarification')).toHaveLength(0);

    internals.checkTaskClarification(now + 5 * 60_000);
    expect(internals.messages.filter((message: any) => message.proactiveKind === 'task-clarification')).toHaveLength(1);
    expect(internals.taskClarificationState.phase).toBe('unknown-asked');
  });
});

describe('SquirlRuntime agents', () => {
  beforeEach(() => {
    testCounter++;
    testHome = join(tmpdir(), `squirl-web-runtime-agents-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
    installFakeCodex();
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6', agents: { codexBin: mockCodexBin } }) + '\n', 'utf-8');
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    mockAssistantContent = 'ok';
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('exposes user and squirl as participants by default', async () => {
    const runtime = await loadRuntime();
    expect(runtime.getState().participants.map((p) => p.id)).toEqual(['user', 'squirl']);
    expect(runtime.listAgents()).toEqual([]);
  });

  it('remaps a provider message id collision instead of overwriting transcript history', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [{
      timestamp: TS_EARLY,
      message: { id: 'codex-squirl-1', role: 'assistant', participantId: 'codex-squirl', content: 'older durable reply' },
    }]);
    const runtime = await loadRuntime();
    await runtime.ready();
    const events: any[] = [];
    const unsubscribe = runtime.subscribeEvents((event) => events.push(event));
    const internals = runtime as unknown as { handleAgentEvent: (event: unknown) => void; persistenceTail: Promise<void> };
    internals.handleAgentEvent({ type: 'message-start', participantId: 'codex-squirl', messageId: 'codex-squirl-1' });
    internals.handleAgentEvent({ type: 'token', participantId: 'codex-squirl', messageId: 'codex-squirl-1', token: 'new reply' });
    internals.handleAgentEvent({ type: 'message-end', participantId: 'codex-squirl', messageId: 'codex-squirl-1', content: 'new reply' });
    await internals.persistenceTail;
    unsubscribe();

    const replies = runtime.getState().messages.filter((message) => message.role === 'assistant' && message.participantId === 'codex-squirl');
    expect(replies).toEqual([
      expect.objectContaining({ id: 'codex-squirl-1', content: 'older durable reply' }),
      expect.objectContaining({ content: 'new reply' }),
    ]);
    expect(replies[1]!.id).toMatch(/^codex-squirl-[0-9a-f-]{36}$/);
    expect(events).toContainEqual(expect.objectContaining({ type: 'toast', message: expect.stringContaining('safe replacement') }));
  });

  it('rehydrates queued agent permission prompts and handles duplicate responses idempotently', async () => {
    const runtime = await loadRuntime();
    const respond = vi.fn(async () => undefined);
    const internals = runtime as unknown as { handleAgentEvent: (event: unknown) => void; coordinator: { respondToInteraction: typeof respond } };
    internals.coordinator.respondToInteraction = respond;
    const request = { id: 'approval-1', method: 'permission', title: 'Run command?', toolName: 'Bash', sessionScope: { key: 'cmd', label: 'Always allow this command for this session' } };
    internals.handleAgentEvent({ type: 'interaction-request', participantId: 'codex', request });
    internals.handleAgentEvent({ type: 'interaction-request', participantId: 'codex', request });
    expect(runtime.getState().agentInteractions).toEqual([{ participantId: 'codex', request }]);
    expect(runtime.getState().messages).toContainEqual(expect.objectContaining({
      role: 'activity',
      activity: expect.objectContaining({ actions: ['approve', 'reject'], provider: expect.objectContaining({ interactionMethod: 'permission' }) }),
    }));

    await runtime.respondToAgentInteraction('codex', 'approval-1', { decision: 'allow-session' });
    await runtime.respondToAgentInteraction('codex', 'approval-1', { decision: 'deny' });
    expect(respond).toHaveBeenCalledOnce();
    expect(runtime.getState().agentInteractions).toEqual([]);
  });

  it('adds and removes a codex agent with bounded write access by default', async () => {
    // Codex start() spawns nothing (per-turn model), so no real subprocess is launched here.
    const runtime = await loadRuntime();

    const result = await runtime.addAgent('codex');
    expect(result).toEqual({ ok: true, id: 'codex', label: 'codex' });
    expect(runtime.getState().participants.map((p) => p.id)).toContain('codex');

    const listed = runtime.listAgents();
    expect(listed.map((a) => a.id)).toEqual(['codex']);
    expect(listed[0]!.mode).toBe('sandbox: workspace-write, approval: on-request');

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
    expect((runtime as unknown as { coordinator: { getDescriptor: (id: string) => { sessionId?: string; sandbox?: string } | undefined } }).coordinator.getDescriptor('review-builder')).toMatchObject({ sandbox: 'danger-full-access', sessionId: 'session-1' });

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
      agents: { codexBin: mockCodexBin, defaults: [{ kind: 'codex', id: 'codex-builder' }] },
    }) + '\n', 'utf-8');
    const runtime = await loadRuntime();
    await vi.waitFor(() => expect(runtime.listAgents().map((agent) => agent.id)).toEqual(['codex-builder']));
    expect(runtime.listAgents().map((agent) => agent.id)).toEqual(['codex-builder']);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(testHome, '.squirl', 'config.json'), 'utf-8')).agents.defaults[0].profileId).toBeTruthy());
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

  it('reclassifies resumed work with a descriptive title instead of publishing a placeholder', async () => {
    const recent = new Date().toISOString();
    writeFileSync(join(testHome, '.squirl', 'task-activity.json'), JSON.stringify({
      version: 3,
      generatedAt: recent,
      sourceWatermark: 'seed',
      tasks: [{
        id: 'task-overview', title: 'Improve overview service layout', summary: 'The overview service layout is being refined.',
        lastActiveAt: recent, participantIds: ['codex-squirl'], evidenceIds: ['overview-request'], source: 'inferred',
      }],
    }) + '\n', 'utf-8');
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    for (let attempt = 0; attempt < 5; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    mockDelegationClassification = '{"decision":"delegate","confidence":"high","targetIds":["codex-squirl"],"task":"the task it was doing before?"}';
    const dispatchTo = vi.fn(async () => undefined);
    const internals = runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo }; taskMetaLLM: any; taskActivitySnapshot: any };
    internals.coordinator.dispatchTo = dispatchTo;
    internals.taskActivitySnapshot = {
      version: 3, generatedAt: recent, sourceWatermark: 'seed',
      tasks: [{
        id: 'task-overview', title: 'Improve overview service layout', summary: 'The overview service layout is being refined.',
        lastActiveAt: recent, participantIds: ['codex-squirl'], evidenceIds: ['overview-request'], source: 'inferred',
      }],
    };
    internals.taskMetaLLM = { complete: async ({ messages }: any) => {
      const input = JSON.parse(messages[0].content);
      const evidenceId = input.recentEvidence.at(-1).id;
      return JSON.stringify({ confidence: 'high', tasks: [{
        title: 'Improve overview service layout',
        summary: 'The overview layout work is active again with workspace access restored.',
        evidenceIds: [evidenceId], previousTaskIds: input.existingTasks[0] ? [input.existingTasks[0].id] : [],
      }] });
    } };

    await runtime.chat('Can you put codex squirrel back on the task it was doing before?', 'squirl', () => undefined);
    for (let attempt = 0; attempt < 10 && runtime.getTaskActivityState().status !== 'ready'; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(preparedHandoffs).toEqual([expect.objectContaining({
      target: expect.objectContaining({ id: 'codex-squirl' }),
      task: 'the task it was doing before?',
    })]);
    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(runtime.getTaskActivityState().tasks[0]).toMatchObject({ title: 'Improve overview service layout' });
    expect(runtime.getTaskActivityState().tasks[0]?.participantIds).toContain('codex-squirl');
    expect(runtime.getTaskActivityState().tasks.some((task) => task.title === 'Resume previous task')).toBe(false);
  });

  it('creates a non-chat uncertain delegation prompt and dispatches it exactly once after yes', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"uncertain","confidence":"low","targetIds":["codex-squirl"],"task":"review the overview"}';

    await runtime.chat('Maybe codex squirrel should review the overview', 'squirl', () => undefined);
    expect(runtime.getState().systemInteractions[0]).toMatchObject({
      kind: 'handoff-confirmation',
      pending: { targetIds: ['codex-squirl'], task: 'review the overview' },
    });
    const interactionId = runtime.getState().systemInteractions[0]!.id;
    expect(runtime.getState().messages.some((message) => message.role === 'assistant' && message.proactiveKind === 'delegation-confirmation')).toBe(false);

    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    await runtime.chat('yes', 'squirl', () => undefined);
    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(preparedHandoffs.at(-1)).toMatchObject({ task: 'review the overview' });
    expect(runtime.getState().systemInteractions).toEqual([]);
    expect(runtime.getState().messages.some((message) => message.role === 'user' && message.content === 'yes')).toBe(false);
    await expect(runtime.respondToSystemInteraction(interactionId, true)).rejects.toThrow('no longer pending');
    expect(dispatchTo).toHaveBeenCalledOnce();
  });

  it('dispatches a contextual approval to the confidently selected project agent', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-k8s', cwd: '/tmp' });
    await runtime.addAgent('codex', { id: 'codex-squirl', cwd: '/tmp/squirl-web-runtime-test' });
    const dispatchTo = vi.fn(async () => undefined);
    const internals = runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo }; messages: any[] };
    internals.coordinator.dispatchTo = dispatchTo;
    internals.messages = [{
      id: 'recommendation', role: 'assistant', participantId: 'codex-k8s',
      content: 'Recommended fix: give Scrum a dedicated 60-second timeout and verify the command.',
    }];
    mockDelegationClassification = '{"decision":"delegate","confidence":"high","targetIds":["codex-squirl"],"task":"Implement the recommended Scrum timeout fix and verify it."}';

    await runtime.chat("yeah let's do it", 'squirl', () => undefined);

    expect(preparedHandoffs.at(-1)).toMatchObject({ target: expect.objectContaining({ id: 'codex-squirl' }), task: 'Implement the recommended Scrum timeout fix and verify it.' });
    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(runtime.getState().messages.find((message) => message.role === 'assistant' && message.handoff?.state === 'dispatched')).toMatchObject({
      handoff: { targetId: 'codex-squirl', state: 'dispatched' },
    });
  });

  it('turns an explicit retry of a legacy handoff card into one durable dispatch', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    const dispatchTo = vi.fn(async () => undefined);
    const internals = runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo }; messages: any[] };
    internals.coordinator.dispatchTo = dispatchTo;
    internals.messages = [{
      id: 'orphan', role: 'assistant',
      content: 'Handoff to @codex-squirl\n\nGoal: Implement the Scrum timeout fix.\n\nOriginal request: Implement the recommended fix.',
    }];

    await runtime.chat('retry that last handoff?', 'squirl', () => undefined);

    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(preparedHandoffs.at(-1)).toMatchObject({ target: expect.objectContaining({ id: 'codex-squirl' }), task: 'Implement the Scrum timeout fix.' });
  });

  it('retries the latest failed durable handoff without creating a new handoff', async () => {
    const runtime = await loadRuntime();
    const retry = vi.fn(async () => true);
    const internals = runtime as unknown as { roomStore: { latestHandoff: () => Promise<any> }; turnScheduler: { retry: typeof retry } };
    internals.roomStore.latestHandoff = async () => ({ id: 'failed-handoff', participantId: 'codex-squirl', status: 'failed' });
    internals.turnScheduler.retry = retry;

    await runtime.chat('retry the last handoff', 'squirl', () => undefined);

    expect(retry).toHaveBeenCalledWith('failed-handoff');
    expect(preparedHandoffs).toEqual([]);
    expect(runtime.getState().messages.at(-1)?.content).toBe('Retrying the handoff to @codex-squirl.');
  });

  it.each([
    ['queued', 'already queued'],
    ['running', 'already running'],
    ['succeeded', 'already completed'],
  ])('does not duplicate a %s durable handoff', async (status, expected) => {
    const runtime = await loadRuntime();
    const retry = vi.fn(async () => true);
    const internals = runtime as unknown as { roomStore: { latestHandoff: () => Promise<any> }; turnScheduler: { retry: typeof retry } };
    internals.roomStore.latestHandoff = async () => ({ id: 'existing-handoff', participantId: 'codex-squirl', status });
    internals.turnScheduler.retry = retry;

    await runtime.chat('retry the last handoff', 'squirl', () => undefined);

    expect(retry).not.toHaveBeenCalled();
    expect(runtime.getState().messages.at(-1)?.content).toContain(expected);
  });

  it('does not turn model-authored handoff prose into delivery state', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    mockAssistantContent = 'Handoff to @codex-squirl\n\nGoal: Implement the fix.';

    await runtime.chat('What should happen next?', 'squirl', () => undefined);

    expect(dispatchTo).not.toHaveBeenCalled();
    const last = runtime.getState().messages.find((message) => message.id === 'web-assistant');
    expect(last).toMatchObject({ content: mockAssistantContent });
    expect(last?.role === 'assistant' ? last.handoff : undefined).toBeUndefined();
  });

  it('routes an ordinary request directly to Squirl before specialist verification', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    const events: any[] = [];

    await runtime.chat('Answer this directly', 'squirl', (event) => events.push(event));

    const routing = events
      .filter((event) => event.type === 'semantic-progress' && event.progress?.stage === 'action-plan')
      .map((event) => event.progress);
    expect(routing[0]).toMatchObject({ state: 'running', label: 'Checking for explicit delegation…' });
    expect(routing).toContainEqual(expect.objectContaining({
      state: 'complete', label: 'Request routing', summary: 'Squirl will answer before considering specialist verification.', output: { kind: 'none' },
    }));
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({ content: 'ok' });
  });

  it('does not let a proactive action replace an informational answer', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockActionDecision = { type: 'action', action: {
      type: 'handoff', targetId: 'codex-squirl', task: 'Answer the BIC card question',
      context: 'The user has a California BIC card.', successCriteria: 'Explain whether EBT needs a separate card.',
    } };

    await runtime.chat('Can I use my BIC card for EBT?', 'squirl', () => undefined);
    expect(runtime.getState().systemInteractions).toHaveLength(0);
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({ content: 'ok' });
    expect(preparedHandoffs).toEqual([]);
  });

  it.each([80, 91])('persists %s%% answer confidence without opening a handoff dialogue', async (confidence) => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockAnswerAssessment = { confidence, action: { type: 'handoff', targetId: 'codex-squirl', task: 'Verify it' } };

    await runtime.chat('Answer this question', 'squirl', () => undefined);
    await waitFor(() => runtime.getState().messages.some((message) => message.id === 'web-assistant' && message.role === 'assistant' && message.responseMeta?.confidenceState !== 'pending'));

    const answer = runtime.getState().messages.find((message) => message.id === 'web-assistant');
    expect(answer).toMatchObject({ content: 'ok', responseMeta: { confidence } });
    expect(runtime.getState().messages.filter((message) => message.role === 'assistant' && message.proactiveKind === 'delegation-confirmation')).toHaveLength(0);
  });

  it('persists current-turn research provenance and gives it to confidence assessment', async () => {
    const runtime = await loadRuntime();
    mockResearchEvidence = {
      id: 'research-tool', role: 'tool', toolCallId: 'search-1', toolName: 'web_search', content: '{}',
      webResearch: { kind: 'search', query: 'current BIC EBT guidance', sources: [{ title: 'Agency', url: 'https://agency.gov/bic', domain: 'agency.gov' }] },
    };

    await runtime.chat('Can I use a BIC card for EBT?', 'squirl', () => undefined);
    await waitFor(() => capturedAssessmentResearch !== null);

    expect(capturedAssessmentResearch).toEqual({
      queries: ['current BIC EBT guidance'],
      sources: [{ title: 'Agency', url: 'https://agency.gov/bic', domain: 'agency.gov', fetched: false }],
      citedSourceCount: 0,
    });
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({
      responseMeta: { research: { queries: ['current BIC EBT guidance'], sources: [{ domain: 'agency.gov' }] } },
    });
  });

  it('preserves a low-confidence answer and dispatches its durable handoff after yes', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockAssistantContent = 'A BIC and EBT card are generally separate, but the details vary by state.';
    mockAnswerAssessment = { confidence: 63, action: {
      type: 'handoff', targetId: 'codex-squirl', task: 'Verify whether the BIC can be used for EBT',
      context: 'The rules may vary by state.', successCriteria: 'Give a clear current answer.',
    } };

    await runtime.chat('Can I use my BIC card for EBT?', 'squirl', () => undefined);
    await waitFor(() => runtime.getState().systemInteractions.length > 0);

    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({
      content: mockAssistantContent, responseMeta: { confidence: 63 },
    });
    expect(runtime.getState().systemInteractions[0]).toMatchObject({
      kind: 'handoff-confirmation',
      pending: { action: { type: 'handoff', targetId: 'codex-squirl' } },
    });

    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    mockAnswerAssessment = { confidence: 95 };
    await runtime.chat('yes', 'squirl', () => undefined);

    expect(dispatchTo).toHaveBeenCalledOnce();
    expect(preparedHandoffs.at(-1)?.task).toContain("Squirl's preliminary answer (63% confidence)");
  });

  it('keeps low confidence without inventing a handoff target', async () => {
    const runtime = await loadRuntime();
    mockAnswerAssessment = { confidence: 42 };
    await runtime.chat('Uncertain question', 'squirl', () => undefined);
    await waitFor(() => runtime.getState().messages.some((message) => message.id === 'web-assistant' && message.role === 'assistant' && message.responseMeta?.confidence === 42));
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({ responseMeta: { confidence: 42 } });
    expect(runtime.getState().messages.some((message) => message.id === 'web-assistant')).toBe(true);
  });

  it('persists unavailable confidence without opening a handoff dialogue', async () => {
    const runtime = await loadRuntime();
    mockAnswerAssessment = { confidence: null };
    await runtime.chat('Uncertain question', 'squirl', () => undefined);
    await waitFor(() => runtime.getState().messages.some((message) => message.id === 'web-assistant' && message.role === 'assistant' && message.responseMeta?.confidenceState === 'unavailable'));
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({ responseMeta: { confidence: null } });
    const last = runtime.getState().messages.at(-1);
    expect(last?.role === 'assistant' ? last.proactiveKind : undefined).toBeUndefined();
  });

  it('cancels pending confidence when a new Squirl message is submitted and ignores the late result', async () => {
    const runtime = await loadRuntime();
    let resolveAssessment!: (value: any) => void;
    let assessmentSignal: AbortSignal | undefined;
    answerAssessmentImplementation = async (...args: any[]) => {
      assessmentSignal = args[5];
      return new Promise((resolve) => { resolveAssessment = resolve; });
    };

    await runtime.chat('first question', 'squirl', () => undefined);
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({ responseMeta: { confidenceState: 'pending' } });

    await runtime.submitChat('follow up', 'squirl', 'follow-up-request');
    expect(assessmentSignal?.aborted).toBe(true);
    expect(runtime.getState().messages.find((message) => message.id === 'web-assistant')).toMatchObject({ responseMeta: { confidenceState: 'canceled' } });

    resolveAssessment({ confidence: 12, action: { type: 'handoff', targetId: 'codex-squirl', task: 'Late handoff' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const answer = runtime.getState().messages.find((message) => message.id === 'web-assistant');
    expect(answer?.role === 'assistant' ? answer.responseMeta?.confidence : undefined).not.toBe(12);
    expect(runtime.getState().systemInteractions).toHaveLength(0);
  });

  it('keeps pending Squirl confidence running when a message targets another agent', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    let resolveAssessment!: (value: any) => void;
    let assessmentSignal: AbortSignal | undefined;
    answerAssessmentImplementation = async (...args: any[]) => {
      assessmentSignal = args[5];
      return new Promise((resolve) => { resolveAssessment = resolve; });
    };

    await runtime.chat('first question', 'squirl', () => undefined);
    await runtime.submitChat('work on this separately', 'codex-squirl', 'specialist-request');
    expect(assessmentSignal?.aborted).toBe(false);

    resolveAssessment({ confidence: 88 });
    await waitFor(() => runtime.getState().messages.some((message) => message.id === 'web-assistant' && message.role === 'assistant' && message.responseMeta?.confidence === 88));
  });

  it('cancels an uncertain delegation after no', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"uncertain","confidence":"low","targetIds":["codex-squirl"],"task":"review this"}';
    await runtime.chat('Maybe codex squirrel should review this', 'squirl', () => undefined);

    const dispatchTo = vi.fn(async () => undefined);
    (runtime as unknown as { coordinator: { dispatchTo: typeof dispatchTo } }).coordinator.dispatchTo = dispatchTo;
    const before = runtime.getState().messages.length;
    await runtime.chat('no', 'squirl', () => undefined);
    expect(dispatchTo).not.toHaveBeenCalled();
    expect(runtime.getState().systemInteractions).toEqual([]);
    expect(runtime.getState().messages).toHaveLength(before);
  });

  it('rejects an approved prompt safely when its target disconnected', async () => {
    const runtime = await loadRuntime();
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    mockDelegationClassification = '{"decision":"uncertain","confidence":"low","targetIds":["codex-squirl"],"task":"review this"}';
    await runtime.chat('Maybe codex squirrel should review this', 'squirl', () => undefined);
    const interactionId = runtime.getState().systemInteractions[0]!.id;
    await runtime.stopAgent('codex-squirl');

    await expect(runtime.respondToSystemInteraction(interactionId, true)).rejects.toThrow('not connected');
    expect(runtime.getState().systemInteractions).toEqual([]);
    expect(runtime.getState().messages.some((message) => message.role === 'assistant' && message.handoff?.state === 'dispatched')).toBe(false);
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

  it('migrates an unexpired legacy confirmation card and hides it from the transcript', async () => {
    const now = new Date();
    writeJsonl(join(historyDir, 'current.jsonl'), [{
      timestamp: now.toISOString(),
      message: {
        id: 'legacy-confirmation', role: 'assistant', content: 'Should I dispatch it? Reply yes or no.',
        proactiveKind: 'delegation-confirmation',
        delegationConfirmation: {
          id: 'legacy-pending', targetIds: ['codex-squirl'], task: 'Review this', originalRequest: 'Maybe Codex should review this',
          createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
    }]);
    const runtime = await loadRuntime();
    await runtime.ready();

    expect(runtime.getState().systemInteractions).toEqual([expect.objectContaining({ id: 'legacy-pending', kind: 'handoff-confirmation' })]);
    expect(runtime.getState().messages.some((message) => message.id === 'legacy-confirmation')).toBe(false);
  });

  it('reconciles direct assignments and final agent responses without provisional titles', async () => {
    const runtime = await loadRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.addAgent('codex', { id: 'codex-squirl' });
    const dispatchTo = vi.fn(async () => undefined);
    const internals = runtime as unknown as {
      coordinator: { dispatchTo: typeof dispatchTo };
      handleAgentEvent: (event: unknown) => void;
      taskMetaLLM: any;
    };
    internals.coordinator.dispatchTo = dispatchTo;
    let taskClassifications = 0;
    internals.taskMetaLLM = { complete: async ({ messages }: any) => {
      taskClassifications += 1;
      const input = JSON.parse(messages[0].content);
      const existing = input.existingTasks[0];
      return JSON.stringify({ confidence: 'high', tasks: [{
        title: 'Separate local AI infrastructure',
        summary: 'Local AI infrastructure is being moved outside the Squirl presentation box.',
        evidenceIds: input.recentEvidence.map((item: any) => item.id),
        previousTaskIds: existing ? [existing.id] : [],
      }] });
    } };

    await runtime.chat('Move local LLM infrastructure outside the Squirl box', 'codex-squirl', () => undefined);
    for (let attempt = 0; attempt < 10 && runtime.getTaskActivityState().tasks.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(taskClassifications).toBeGreaterThan(0);
    const assigned = runtime.getTaskActivityState().tasks[0]!;
    expect(assigned).toMatchObject({ title: 'Separate local AI infrastructure', participantIds: ['codex-squirl'] });

    internals.handleAgentEvent({ type: 'message-start', participantId: 'codex-squirl', messageId: 'agent-update' });
    internals.handleAgentEvent({ type: 'message-end', participantId: 'codex-squirl', messageId: 'agent-update', content: 'Working on the overview now.' });
    for (let attempt = 0; attempt < 10 && !runtime.getTaskActivityState().tasks[0]?.evidenceIds.includes('agent-update'); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const advanced = runtime.getTaskActivityState().tasks[0]!;
    expect(advanced.id).toBe(assigned.id);
    expect(Date.parse(advanced.lastActiveAt)).toBeGreaterThanOrEqual(Date.parse(assigned.lastActiveAt));
    expect(taskClassifications).toBeGreaterThanOrEqual(2);
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

  it('keeps a dedicated task model without semantic indexing', async () => {
    const runtime = await loadRuntime();
    const internals = runtime as unknown as { taskMetaLLM: unknown; routingMetaLLM: unknown };
    expect(internals.taskMetaLLM).toBeTruthy();
    expect(internals.taskMetaLLM).not.toBe(internals.routingMetaLLM);
  });

  it('preserves reliable tasks, reports timeouts, and retries before calendar sync', async () => {
    const recent = new Date().toISOString();
    writeJsonl(join(historyDir, 'current.jsonl'), [entry('retry-task-user', 'user', 'research durable voice options', recent)]);
    const runtime = await loadRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.useFakeTimers();
    try {
      let classifications = 0;
      const refreshCalendar = vi.fn(async () => undefined);
      const internals = runtime as unknown as {
        config: any;
        taskMetaLLM: any;
        taskActivitySnapshot: any;
        taskRefreshFailed: boolean;
        taskSourceDirty: boolean;
        taskRefreshRunning: boolean;
        taskRefreshQueued: boolean;
        taskRefreshScheduled: boolean;
        taskRefreshRetryAttempt: number;
        taskRefreshRetryTimer: unknown;
        markTaskActivityChanged: () => void;
        refreshCalendar: typeof refreshCalendar;
      };
      internals.config.calendar = { syncInferredTasks: true };
      internals.refreshCalendar = refreshCalendar;
      internals.taskActivitySnapshot = {
        version: 3, generatedAt: recent, sourceWatermark: 'reliable',
        tasks: [{ id: 'reliable', title: 'Preserve reliable task state', summary: 'This task must survive a failed refresh.', lastActiveAt: recent, participantIds: [], evidenceIds: ['old'] }],
      };
      internals.taskRefreshFailed = false;
      internals.taskSourceDirty = false;
      internals.taskRefreshRunning = false;
      internals.taskRefreshQueued = false;
      internals.taskRefreshScheduled = false;
      internals.taskMetaLLM = { complete: async () => {
        classifications += 1;
        if (classifications <= 4) throw new Error('Request timed out. secret=https://private.invalid');
        return JSON.stringify({ confidence: 'high', tasks: [{
          title: 'Research durable voice options',
          summary: 'Current work is comparing voice options for Squirl.',
          evidenceIds: ['retry-task-user'], previousTaskIds: [],
        }] });
      } };

      internals.markTaskActivityChanged();
      await vi.runAllTicks();
      await Promise.resolve();
      await Promise.resolve();

      expect(runtime.getTaskActivityState()).toMatchObject({
        status: 'stale',
        error: 'Task classification timed out; retrying automatically.',
        tasks: [{ title: 'Preserve reliable task state' }],
      });
      expect(internals.taskRefreshRetryAttempt).toBe(1);
      expect(internals.taskRefreshRetryTimer).toBeTruthy();
      expect(refreshCalendar).not.toHaveBeenCalled();

      for (const [index, delay] of [30_000, 60_000, 120_000, 300_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay);
        await vi.runAllTicks();
        await Promise.resolve();
        expect(classifications).toBe(index + 2);
        if (index < 3) {
          expect(runtime.getTaskActivityState()).toMatchObject({ status: 'stale', tasks: [{ title: 'Preserve reliable task state' }] });
          expect(internals.taskRefreshRetryAttempt).toBe(index + 2);
          expect(refreshCalendar).not.toHaveBeenCalled();
        }
      }

      expect(classifications).toBe(5);
      expect(runtime.getTaskActivityState()).toMatchObject({
        status: 'ready', error: null, tasks: [{ title: 'Research durable voice options' }],
      });
      expect(internals.taskRefreshRetryAttempt).toBe(0);
      expect(internals.taskRefreshRetryTimer).toBeNull();
      expect(refreshCalendar).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
      return JSON.stringify({ confidence: 'high', tasks: [{ title: 'Improve inferred task visibility', summary: 'The runtime is classifying recent work into a sidebar task feed.', evidenceIds: ['task-user'], previousTaskIds: [] }] });
    } };
    internals.taskActivityEmit = (event) => events.push(event);
    internals.markTaskActivityChanged();
    internals.markTaskActivityChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(classifications).toBe(1);
    expect(runtime.getTaskActivityState()).toMatchObject({ status: 'ready', tasks: [{ title: 'Improve inferred task visibility' }] });
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
    expect(runtime.getStatus().contextOrigin).toBe('preview');
  });

  it('uses the latest exact request for both displayed usage and window', async () => {
    writeConfig({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' });
    const runtime = await loadRuntime();
    mockContextSnapshot = {
      origin: 'exact', capturedAt: '2026-07-14T17:30:00.524Z', modelId: 'local-test',
      approximateTokens: 8_744, contextWindow: 17_120, sections: [], renderedDocument: '', discs: [],
    };

    expect(runtime.getStatus()).toMatchObject({
      tokenCount: 8_744,
      contextWindow: 17_120,
      contextOrigin: 'exact',
      contextCapturedAt: '2026-07-14T17:30:00.524Z',
    });
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
    expect(events.find((e) => e.type === 'assistant-final')?.message.responseMeta).toEqual({ model: 'claude-sonnet-4-6', confidenceState: 'pending' });
  });
});

describe('SquirlRuntime durable pipeline traces', () => {
  beforeEach(() => {
    testCounter++;
    testHome = join(tmpdir(), `squirl-web-traces-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(testHome, '.squirl', 'config.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' }) + '\n', 'utf-8');
    writeJsonl(join(historyDir, 'current.jsonl'), []);
  });

  afterEach(() => { rmSync(testHome, { recursive: true, force: true }); });

  it('retains a completed trace after work settles and restores it in a new runtime', async () => {
    const store = new MemoryRoomStore();
    const first = await loadRuntime(store);
    await first.ready();
    await first.chat('trace this turn', 'squirl', () => undefined);
    await waitFor(() => first.getStatus().recentPipelineTraces[0]?.stages.some((stage) => stage.id === 'confidence' && stage.state === 'succeeded') ?? false);
    const completed = first.getState();
    expect(completed.work.active).toEqual([]);
    expect(completed.status.recentPipelineTraces[0]).toMatchObject({
      state: 'succeeded', assistantMessageId: 'web-assistant', request: 'trace this turn',
    });
    await first.shutdown();

    const restored = await loadRuntime(store);
    await restored.ready();
    expect(restored.getStatus().recentPipelineTraces[0]).toMatchObject({
      state: 'succeeded', assistantMessageId: 'web-assistant', request: 'trace this turn',
    });
    await restored.shutdown();
  });

  it('closes an orphaned running trace during restart recovery', async () => {
    const store = new MemoryRoomStore();
    const { createTurnPipelineTrace } = await import('../pipeline-trace.js');
    await store.savePipelineTrace(createTurnPipelineTrace('orphaned-turn', 'interrupted request'), 10);
    const runtime = await loadRuntime(store);
    await runtime.ready();
    expect(runtime.getStatus().recentPipelineTraces[0]).toMatchObject({ turnId: 'orphaned-turn', state: 'failed' });
    expect((await store.loadRecentPipelineTraces(10))[0]).toMatchObject({ turnId: 'orphaned-turn', state: 'failed' });
    await runtime.shutdown();
  });
});
