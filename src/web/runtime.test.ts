import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome: string;
let historyDir: string;
let testCounter = 0;
let capturedHistory: any[] = [];

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
      assistant.content = 'ok';
      callbacks.onToken('ok', { ...assistant });
      assistant.isStreaming = false;
      callbacks.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
      return [user, { ...assistant, content: 'ok', isStreaming: false }];
    }
  },
}));

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
      entry('u1', 'user', 'before startup', '2026-06-17T12:00:00.000Z'),
    ]);
    const runtime = await loadRuntime();

    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'before startup', '2026-06-17T12:00:00.000Z'),
      entry('u2', 'user', 'terminal message', '2026-06-17T12:01:00.000Z'),
    ]);

    expect(runtime.getState().messages.map((message) => message.content)).toContain('terminal message');
  });

  it('uses the latest disk history as context for web chat', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'initial', '2026-06-17T12:00:00.000Z'),
    ]);
    const runtime = await loadRuntime();

    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'initial', '2026-06-17T12:00:00.000Z'),
      entry('a1', 'assistant', 'terminal reply', '2026-06-17T12:01:00.000Z'),
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
