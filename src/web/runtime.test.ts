import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome: string;
let historyDir: string;
let testCounter = 0;
let capturedHistory: any[] = [];
let mockDetectedModels: Array<{ id: string; contextWindow?: number }> = [];
let mockAssistantContent = 'ok';

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
    getContextFiles() { return new Map(this.contextFiles); }
    addContextFile(path: string) { this.contextFiles.set(path, 'content'); }
    removeContextFile(path: string) { this.contextFiles.delete(path); }
    clearContextFiles() { this.contextFiles.clear(); }
    async chat(input: string, conversationHistory: any[], _model: any, callbacks: any) {
      capturedHistory = conversationHistory;
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

function writeJsonl(filePath: string, entries: Array<{ timestamp: string; message: any }>) {
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

function entry(id: string, role: 'user' | 'assistant', content: string, timestamp: string) {
  return { timestamp, message: { id, role, content } };
}

async function loadRuntime() {
  vi.resetModules();
  capturedHistory = [];
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

  it('uses the latest disk history as context for web chat', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'initial', TS_EARLY),
    ]);
    const runtime = await loadRuntime();

    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'initial', TS_EARLY),
      entry('a1', 'assistant', 'terminal reply', TS_LATE),
    ]);

    await runtime.chat('web message', () => {});

    expect(capturedHistory.map((message) => message.content)).toEqual(['initial', 'terminal reply']);
  });

  it('persists completed web assistant replies into shared history', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), []);
    const runtime = await loadRuntime();

    await runtime.chat('web message', () => {});

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

    await runtime.chat('web message', (event) => { events.push(event); });

    expect(events).toContainEqual({
      type: 'assistant-update',
      message: { id: 'web-assistant', role: 'assistant', content: 'ok', isStreaming: true },
    });
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

  it('adds and removes a codex agent with conservative defaults', async () => {
    // Codex start() spawns nothing (per-turn model), so no real subprocess is launched here.
    const runtime = await loadRuntime();

    const result = await runtime.addAgent('codex');
    expect(result).toEqual({ ok: true, id: 'codex', label: 'codex' });
    expect(runtime.getState().participants.map((p) => p.id)).toContain('codex');

    const listed = runtime.listAgents();
    expect(listed.map((a) => a.id)).toEqual(['codex']);
    expect(listed[0]!.mode).toBe('sandbox: read-only');

    expect(await runtime.stopAgent('codex')).toBe(true);
    expect(runtime.listAgents()).toEqual([]);
    expect(await runtime.stopAgent('codex')).toBe(false);
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

    await runtime.chat('hello', (event) => { events.push(event); });

    expect(events).toContainEqual({ type: 'toast', level: 'error', message: 'The model returned an empty response.' });
  });

  it('does not toast when the model returns content', async () => {
    mockAssistantContent = 'ok';
    const runtime = await loadRuntime();
    const events: any[] = [];

    await runtime.chat('hello', (event) => { events.push(event); });

    expect(events.some((e) => e.type === 'toast')).toBe(false);
  });
});
