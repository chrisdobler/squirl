import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  afterEach(() => vi.unstubAllGlobals());

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
    const semanticProgress: Array<{ stage: string; state: string; output?: unknown }> = [];

    const returned = await orchestrator.chat(
      'hello',
      [],
      { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
      {
        onNewMessage: (message) => { callbackMessages.push(message); },
        onToken: (_token, assistant) => { tokenSnapshots.push(assistant); },
        onDone: () => {},
        onError: () => {},
        onSemanticProgress: (progress) => { semanticProgress.push(progress); },
      },
    );

    const callbackAssistant = callbackMessages.find((message): message is AssistantMessage => message.role === 'assistant');
    const returnedAssistant = returned.find((message): message is AssistantMessage => message.role === 'assistant');

    expect(callbackAssistant?.content).toBe('');
    expect(tokenSnapshots.map((snapshot) => snapshot.content)).toEqual(["I'm"]);
    expect(returnedAssistant?.content).toBe("I'm");
    expect(semanticProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'capability', state: 'complete' }),
      expect.objectContaining({ stage: 'turn-intent', state: 'complete' }),
      expect.objectContaining({ stage: 'context', state: 'complete' }),
    ]));
  });

  it('omits ambient project and agent activity context from ordinary turns but includes agent activity for coordination', async () => {
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken('ok');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-no-ambient-project', { snapshotPersistence: false });
    orchestrator.setIdentityContext({ participants: [
      { id: 'user', label: 'Chris' }, { id: 'squirl', label: 'Squirl' }, { id: 'codex-squirl', label: 'Codex' },
    ] });

    await orchestrator.chat('Explain semantic search', [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, { onToken: () => {}, onDone: () => {}, onError: () => {} });
    const ordinary = mocks.streamChatCompletion.mock.calls.at(-1)![0].messages;
    expect(ordinary.some((message: any) => String(message.content).includes('Project context (evidence'))).toBe(false);
    expect(ordinary.some((message: any) => String(message.content).includes('Current agent activity'))).toBe(false);

    await orchestrator.chat('What is Codex working on?', [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, { onToken: () => {}, onDone: () => {}, onError: () => {} });
    const coordination = mocks.streamChatCompletion.mock.calls.at(-1)![0].messages;
    expect(coordination.some((message: any) => String(message.content).includes('Current agent activity'))).toBe(true);
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
    expect(snapshot!.sections.some((section) => section.label.startsWith('Tool result') && section.content.includes('"rejected":true'))).toBe(true);
    expect(snapshot!.sections.at(-1)!.label).toBe('Tool result · call-1');
  });

  it('rejects a hallucinated command on a knowledge turn and preserves the declined trace outcome', async () => {
    let request = 0;
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      request++;
      if (request === 1) options.onToolCalls?.([{ id: 'command-1', name: 'run_command', arguments: '{"command":"ebt balance","cwd":"BIC card"}' }]);
      else options.onToken('A BIC and EBT card are separate program credentials.');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-tool-gate', { snapshotPersistence: false });
    const messages: Message[] = [];
    const traces: Array<{ id: string; state?: string }> = [];
    const starts: string[] = [];
    await orchestrator.chat('Can I use my BIC card for EBT?', [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, {
      onNewMessage: (message) => { messages.push(message); },
      onToken: () => {}, onDone: () => {}, onError: () => {},
      onToolStart: (name) => { starts.push(name); },
      onTrace: (trace) => { traces.push(trace); },
    });

    expect(mocks.streamChatCompletion.mock.calls.at(-2)![0].tools).toBeUndefined();
    expect(starts).not.toContain('run_command');
    expect(messages).toContainEqual(expect.objectContaining({
      role: 'tool', toolName: 'run_command', toolStatus: 'error',
      toolRejection: { reason: 'not-allowed', summary: 'this turn did not request workspace execution' },
    }));
    expect(traces.filter((trace) => trace.id === 'native-tools').at(-1)?.state).toBe('declined');
  });

  it('finalizes pre-tool planning with its tool calls before starting the answer generation', async () => {
    let request = 0;
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      request++;
      if (request === 1) {
        options.onToken('I will inspect the project first.');
        options.onToolCalls?.([{ id: 'call-preview', name: 'not_a_real_tool', arguments: '{}' }]);
      } else {
        options.onToken('Final answer.');
      }
      options.onDone({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-planning-preview-test', { snapshotPersistence: false });
    const completed: AssistantMessage[] = [];

    await orchestrator.chat('inspect this', [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, {
      onToken: () => {},
      onDone: (_usage, assistant) => { completed.push(assistant); },
      onError: () => {},
    });

    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ content: 'I will inspect the project first.', toolCalls: [{ id: 'call-preview' }] });
    expect(completed[1]).toMatchObject({ content: 'Final answer.', toolCalls: undefined });
  });

  it('requests first-use consent, executes SearXNG search, and retains structured provenance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [
      { title: 'Benefits agency', url: 'https://agency.gov/cards', content: 'Official card guidance' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    let request = 0;
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      request++;
      if (request === 1) options.onToolCalls?.([{ id: 'search-1', name: 'web_search', arguments: '{"query":"California BIC EBT card current guidance"}' }]);
      else options.onToken('Use the current agency guidance.');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-research-test', { snapshotPersistence: false });
    orchestrator.setResearchConfig({ consent: 'unknown', mode: 'automatic', searxngUrl: 'http://searxng:8080', maxResults: 5 });
    const messages: Message[] = [];
    const approvals: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await orchestrator.chat('Can I use a BIC card for EBT?', [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, {
      onNewMessage: (message) => { messages.push(message); }, onToken: () => {}, onDone: () => {}, onError: () => {},
      onToolApproval: async (name, args) => {
        approvals.push({ name, args });
        orchestrator.setResearchConfig({ enabled: true, consent: 'allowed', mode: 'automatic', searxngUrl: 'http://searxng:8080', maxResults: 5 });
        return true;
      },
    });

    expect(approvals).toEqual([{ name: 'web_search', args: { query: 'Can I use a BIC card for EBT?' } }]);
    expect((mocks.streamChatCompletion.mock.calls.at(-2)![0].tools ?? []).map((tool: any) => tool.function.name)).not.toContain('web_search');
    expect(messages.some((message) => message.role === 'tool' && message.toolCallId.startsWith('preflight-'))).toBe(false);
    expect(result).toContainEqual(expect.objectContaining({
      role: 'tool', toolName: 'web_search',
      webResearch: { kind: 'search', query: 'Can I use a BIC card for EBT?', sources: [{ title: 'Benefits agency', url: 'https://agency.gov/cards', domain: 'agency.gov' }] },
    }));
  });

  it('routes current news deterministically without awaiting the semantic classifier', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('http://searxng:8080')) {
        return new Response(JSON.stringify({ results: [
          { title: 'Current headline', url: 'https://news.example/story', content: 'A current story' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('<html><body><main>Current headline details.</main></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }));
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken('The current headline is supported by live research.');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-nonblocking-intent-test', { snapshotPersistence: false });
    const semanticComplete = vi.fn(() => new Promise<string>(() => {}));
    orchestrator.setTurnIntentLLM({ complete: semanticComplete });
    orchestrator.setResearchConfig({ enabled: true, consent: 'allowed', mode: 'automatic', searxngUrl: 'http://searxng:8080', maxResults: 5 });
    const traces: Array<{ id: string; state?: string; service?: string; detail?: string }> = [];

    const result = await orchestrator.chat("What's the hottest topic in the news right now?", [], { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' }, {
      onToken: () => {}, onDone: () => {}, onError: () => {},
      onTrace: (trace) => { traces.push(trace); },
    });

    expect(semanticComplete).not.toHaveBeenCalled();
    expect(traces).toContainEqual(expect.objectContaining({ id: 'turn-intent', state: 'succeeded', service: 'deterministic policy' }));
    expect(traces).toContainEqual(expect.objectContaining({ id: 'research-search', state: 'succeeded' }));
    expect(result).toContainEqual(expect.objectContaining({ role: 'tool', toolName: 'web_search' }));
    expect(result).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'The current headline is supported by live research.' }));
  });

  it('sends multi-day archive turns beyond the visible history cap and records the resolved window', async () => {
    const historyDir = `${snapshotHome}/.squirl/history`;
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const archive = Array.from({ length: 60 }, (_, index) => JSON.stringify({
      timestamp: `2026-07-12T12:${String(index).padStart(2, '0')}:00Z`,
      message: { id: `archive-${index}`, role: 'user', content: `prior-day-${index}` },
    })).join('\n');
    writeFileSync(`${historyDir}/2026-07-12.jsonl`, `${archive}\n`, 'utf-8');
    writeFileSync(`${historyDir}/current.jsonl`, `${JSON.stringify({
      timestamp: '2026-07-13T12:00:00Z',
      message: { id: 'today', role: 'user', content: 'today-small-message' },
    })}\n`, 'utf-8');

    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken('done');
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });
    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-multi-day-test', { snapshotPersistence: false });
    await orchestrator.chat(
      'current request',
      [{ id: 'today', role: 'user', content: 'today-small-message' }],
      { id: 'local-test', label: 'local-test', provider: 'local', contextWindow: 17_120 },
      { onToken: () => {}, onDone: () => {}, onError: () => {} },
    );

    const sent = mocks.streamChatCompletion.mock.calls.at(-1)![0].messages.map((message: any) => message.content);
    expect(sent).toContain('prior-day-0');
    expect(sent).toContain('today-small-message');
    expect(sent).toContain('current request');
    expect(sent.filter((content: unknown) => content === 'current request')).toHaveLength(1);
    expect(orchestrator.getLatestContextSnapshot()).toMatchObject({ contextWindow: 17_120, origin: 'exact' });
    expect(orchestrator.getLatestContextSnapshot()!.sections.some((section) => section.category === 'messages' && section.content === 'prior-day-0')).toBe(true);

    rmSync(historyDir, { recursive: true, force: true });
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
