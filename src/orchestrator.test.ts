import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import type { StreamOptions } from './api.js';
import type { MemoryPipeline } from './search/memory-pipeline.js';
import type { AssistantMessage, Message } from './types.js';

const mocks = vi.hoisted(() => ({
  streamChatCompletion: vi.fn(),
}));
const snapshotHome = `/tmp/squirl-orchestrator-snapshots-${process.pid}`;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => snapshotHome };
});

vi.mock('./api.js', () => ({
  streamChatCompletion: mocks.streamChatCompletion,
}));

describe('Orchestrator streaming callbacks', () => {
  beforeAll(() => mkdirSync(snapshotHome, { recursive: true }));
  afterAll(() => rmSync(snapshotHome, { recursive: true, force: true }));

  it('restores the persisted exact request for the same workspace at startup', async () => {
    const { buildContextSnapshot } = await import('./context/context-snapshot.js');
    const { saveContextSnapshot } = await import('./context/context-snapshot-store.js');
    const { Orchestrator } = await import('./orchestrator.js');
    const workspace = '/workspace/persisted-context';
    const exact = buildContextSnapshot([{ role: 'user', content: 'persist me' }], undefined, 'gpt-4o', 1000, 'saved-at');
    saveContextSnapshot(workspace, exact);
    const orchestrator = new Orchestrator(workspace);
    expect(orchestrator.getLatestContextSnapshot()?.renderedDocument).toBe('persist me');
    expect(orchestrator.getContextSnapshot([], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }).origin).toBe('exact');
  });

  it('builds a labeled preview before the first exact request', async () => {
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-orchestrator-test', { snapshotPersistence: false });
    const preview = orchestrator.getContextSnapshot(
      [{ id: 'u-existing', role: 'user', content: 'existing conversation word for word' }],
      { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
    );
    expect(preview.origin).toBe('preview');
    expect(preview.renderedDocument).toContain('existing conversation word for word');
    expect(preview.sections.some((section) => section.role === 'system')).toBe(true);
    expect(orchestrator.getLatestContextSnapshot()).toBeNull();
  });

  it('does not mutate the assistant message object passed to onNewMessage', async () => {
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken("I'm");
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });

    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-orchestrator-test', { snapshotPersistence: false });
    const callbackMessages: Message[] = [];
    const tokenSnapshots: AssistantMessage[] = [];

    const returned = await orchestrator.chat(
      'hello',
      [],
      { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
      {
        onNewMessage: (message) => { callbackMessages.push(message); },
        onToken: (_token, assistant) => { tokenSnapshots.push(assistant); },
        onDone: () => {},
        onError: () => {},
      },
    );

    const callbackAssistant = callbackMessages.find((message): message is AssistantMessage => message.role === 'assistant');
    const returnedAssistant = returned.find((message): message is AssistantMessage => message.role === 'assistant');

    expect(callbackAssistant?.content).toBe('');
    expect(tokenSnapshots.map((snapshot) => snapshot.content)).toEqual(["I'm"]);
    expect(returnedAssistant?.content).toBe("I'm");
  });

  it('uses a local model live context window for truncation and preserves the current request', async () => {
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken('instrumentation answer');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });

    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-orchestrator-live-window', { snapshotPersistence: false });
    const memorySentinel = `RECALLED_SENTINEL ${'memory '.repeat(2_800)}`;
    orchestrator.setMemoryPipeline({
      retrieve: vi.fn().mockResolvedValue({
        results: [],
        systemMessage: memorySentinel,
        inlineDisplay: '',
        queries: [],
      }),
    } as unknown as MemoryPipeline);

    const currentRequest = 'What instrumentation should a coding harness capture?';
    await orchestrator.chat(
      currentRequest,
      [],
      {
        id: 'local-model-with-live-window',
        label: 'local-model-with-live-window',
        provider: 'local',
        contextWindow: 17_120,
      },
      { onToken: () => {}, onDone: () => {}, onError: () => {} },
    );

    const requestMessages = mocks.streamChatCompletion.mock.calls.at(-1)![0].messages;
    const snapshot = orchestrator.getLatestContextSnapshot();
    expect(snapshot?.contextWindow).toBe(17_120);
    expect(requestMessages.at(-1)?.content).toBe(currentRequest);
    expect(requestMessages.some((message: { content?: unknown }) =>
      typeof message.content === 'string' && message.content.includes('RECALLED_SENTINEL'))).toBe(true);
  });

  it('captures the exact latest primary request, including tool-loop additions', async () => {
    let request = 0;
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      request++;
      if (request === 1) {
        options.onToolCalls?.([{ id: 'call-1', name: 'not_a_real_tool', arguments: '{"value":"word for word"}' }]);
      } else {
        options.onToken('done');
      }
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-orchestrator-test', { snapshotPersistence: false });
    await orchestrator.chat('inspect this', [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, {
      onToken: () => {}, onDone: () => {}, onError: () => {},
    });

    const finalCallMessages = mocks.streamChatCompletion.mock.calls.at(-1)![0].messages;
    const snapshot = orchestrator.getLatestContextSnapshot();
    expect(request).toBe(2);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.origin).toBe('exact');
    expect(snapshot!.sections.slice(0, finalCallMessages.length).map((section) => section.content))
      .toEqual(finalCallMessages.map((message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '', null, 2)));
    expect(snapshot!.sections.some((section) => section.label === 'Assistant tool call' && section.metadata?.includes('word for word'))).toBe(true);
    expect(snapshot!.sections.some((section) => section.label.startsWith('Tool result') && section.content === 'Unknown tool: not_a_real_tool')).toBe(true);
    expect(snapshot!.sections.at(-1)!.label).toBe('Tool definitions');
  });

  it('prepares a concise authorized handoff without executing the task', async () => {
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken('Handoff to @cc\n\nGoal: make a plan');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-orchestrator-test', { snapshotPersistence: false });
    const result = await orchestrator.prepareHandoff(
      { id: 'cc', label: 'Claude Code' },
      'tell cc to make a plan',
      'make a plan',
      [],
      { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
    );
    expect(result).toContain('Handoff to @cc');
    const prompt = mocks.streamChatCompletion.mock.calls.at(-1)?.[0].messages.at(-1)?.content;
    expect(prompt).toContain('explicitly authorized an immediate handoff');
    expect(prompt).toContain('Original request:\ntell cc to make a plan');
  });
});
