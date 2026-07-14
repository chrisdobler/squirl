import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testHome: string;
let historyDir: string;
let testCounter = 0;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    // Dynamic — each resetModules() picks up the latest testHome
    get homedir() {
      return () => testHome;
    },
  };
});

function writeJsonl(filePath: string, entries: Array<{ timestamp: string; message: any }>) {
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function entry(id: string, role: 'user' | 'assistant', content: string, timestamp: string) {
  return { timestamp, message: { id, role, content } };
}

describe('loadHistory', () => {
  beforeEach(() => {
    vi.resetModules();
    testCounter++;
    testHome = join(tmpdir(), `squirl-test-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns messages from current.jsonl when recent', async () => {
    const now = new Date().toISOString();
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'hello', now),
      entry('a1', 'assistant', 'hi', now),
    ]);

    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('hello');
  });

  it('backfills from daily archives when current.jsonl is empty', async () => {
    writeFileSync(join(historyDir, 'current.jsonl'), '', 'utf-8');

    writeJsonl(join(historyDir, '2026-04-10.jsonl'), [
      entry('u1', 'user', 'old question', '2026-04-10T12:00:00Z'),
      entry('a1', 'assistant', 'old answer', '2026-04-10T12:00:01Z'),
    ]);

    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('old question');
    expect(messages[1]!.content).toBe('old answer');
  });

  it('backfills from multiple daily files, newest first', async () => {
    writeFileSync(join(historyDir, 'current.jsonl'), '', 'utf-8');

    writeJsonl(join(historyDir, '2026-04-08.jsonl'), [
      entry('u1', 'user', 'day1', '2026-04-08T12:00:00Z'),
      entry('a1', 'assistant', 'day1-reply', '2026-04-08T12:00:01Z'),
    ]);
    writeJsonl(join(historyDir, '2026-04-09.jsonl'), [
      entry('u2', 'user', 'day2', '2026-04-09T12:00:00Z'),
      entry('a2', 'assistant', 'day2-reply', '2026-04-09T12:00:01Z'),
    ]);

    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    expect(messages).toHaveLength(4);
    expect(messages[0]!.content).toBe('day1');
    expect(messages[2]!.content).toBe('day2');
  });

  it('combines current + archive messages', async () => {
    const now = new Date().toISOString();
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u-now', 'user', 'recent', now),
      entry('a-now', 'assistant', 'recent-reply', now),
    ]);

    writeJsonl(join(historyDir, '2026-04-09.jsonl'), [
      entry('u-old', 'user', 'archive', '2026-04-09T12:00:00Z'),
      entry('a-old', 'assistant', 'archive-reply', '2026-04-09T12:00:01Z'),
    ]);

    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    expect(messages.length).toBe(4);
    const contents = messages.map((m) => m.content);
    expect(contents.indexOf('archive')).toBeLessThan(contents.indexOf('recent'));
  });

  it('returns everything when total history is less than MAX_HISTORY', async () => {
    const now = new Date().toISOString();
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'recent', now),
    ]);

    writeJsonl(join(historyDir, '2026-04-09.jsonl'), [
      entry('u2', 'user', 'old', '2026-04-09T12:00:00Z'),
    ]);

    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    // Both messages returned even though total < 50
    expect(messages).toHaveLength(2);
  });

  it('caps at MAX_HISTORY (50) when archives have more', async () => {
    writeFileSync(join(historyDir, 'current.jsonl'), '', 'utf-8');

    // Write 30 entries to each of two daily files = 60 total
    const day1Entries = Array.from({ length: 30 }, (_, i) =>
      entry(`d1-${i}`, 'user', `day1-${i}`, '2026-04-08T12:00:00Z'),
    );
    const day2Entries = Array.from({ length: 30 }, (_, i) =>
      entry(`d2-${i}`, 'user', `day2-${i}`, '2026-04-09T12:00:00Z'),
    );

    writeJsonl(join(historyDir, '2026-04-08.jsonl'), day1Entries);
    writeJsonl(join(historyDir, '2026-04-09.jsonl'), day2Entries);

    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    expect(messages).toHaveLength(50);
    // Should have the most recent 50: all 30 from day2 + last 20 from day1
    expect(messages[0]!.content).toBe('day1-10');
    expect(messages[49]!.content).toBe('day2-29');
  });

  it('loads the complete ordered multi-day transcript for prompt selection', async () => {
    writeFileSync(join(historyDir, 'current.jsonl'), '', 'utf-8');
    writeJsonl(join(historyDir, '2026-04-08.jsonl'), Array.from({ length: 30 }, (_, i) =>
      entry(`d1-${i}`, 'user', `day1-${i}`, `2026-04-08T12:${String(i).padStart(2, '0')}:00Z`),
    ));
    writeJsonl(join(historyDir, '2026-04-09.jsonl'), Array.from({ length: 30 }, (_, i) =>
      entry(`d2-${i}`, 'user', `day2-${i}`, `2026-04-09T12:${String(i).padStart(2, '0')}:00Z`),
    ));

    const { loadHistory, loadPromptHistory } = await import('./history.js');
    expect(loadHistory()).toHaveLength(50);
    const promptHistory = loadPromptHistory();
    expect(promptHistory).toHaveLength(60);
    expect(promptHistory[0]!.content).toBe('day1-0');
    expect(promptHistory.at(-1)!.content).toBe('day2-29');
  });

  it('loads complete durable history for agent activity even beyond the chat window', async () => {
    writeJsonl(join(historyDir, '2026-04-08.jsonl'), Array.from({ length: 60 }, (_, i) =>
      entry(`agent-${i}`, 'user', `assignment-${i}`, `2026-04-08T12:${String(i).padStart(2, '0')}:00Z`),
    ));
    const importsDir = join(historyDir, 'imports');
    mkdirSync(importsDir, { recursive: true });
    writeJsonl(join(importsDir, 'chatgpt.jsonl'), [entry('imported', 'user', 'not Squirl activity', '2026-04-08T13:00:00Z')]);
    const { loadAllHistoryEntries, loadAllHistoryMessages } = await import('./history.js');
    expect(loadAllHistoryMessages()).toHaveLength(60);
    expect(loadAllHistoryEntries().some((item) => item.message.id === 'imported')).toBe(false);
  });

  it('returns empty when no history exists at all', async () => {
    const { loadHistory } = await import('./history.js');
    const messages = loadHistory();
    expect(messages).toHaveLength(0);
  });
});

describe('rewindHistoryAfter', () => {
  beforeEach(() => {
    vi.resetModules();
    testCounter++;
    testHome = join(tmpdir(), `squirl-test-${process.pid}-${testCounter}`);
    historyDir = join(testHome, '.squirl', 'history');
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('removes messages after the target id and preserves retained timestamps', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'hello', '2026-04-10T12:00:00Z'),
      entry('a1', 'assistant', 'hi', '2026-04-10T12:00:01Z'),
      entry('u2', 'user', 'dirty', '2026-04-10T12:00:02Z'),
      entry('a2', 'assistant', 'reply', '2026-04-10T12:00:03Z'),
    ]);

    const { rewindHistoryAfter, readEntries } = await import('./history.js');
    const result = rewindHistoryAfter('a1');

    expect(result.targetFound).toBe(true);
    expect(result.removed.map((m) => m.id)).toEqual(['u2', 'a2']);

    const entries = readEntries(join(historyDir, 'current.jsonl'));
    expect(entries.map((e) => e.message.id)).toEqual(['u1', 'a1']);
    expect(entries[1]!.timestamp).toBe('2026-04-10T12:00:01Z');
  });

  it('can remove all writable history with a null target', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'hello', '2026-04-10T12:00:00Z'),
      entry('a1', 'assistant', 'hi', '2026-04-10T12:00:01Z'),
    ]);

    const { rewindHistoryAfter, readEntries } = await import('./history.js');
    const result = rewindHistoryAfter(null);

    expect(result.targetFound).toBe(true);
    expect(result.removed.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(readEntries(join(historyDir, 'current.jsonl'))).toEqual([]);
  });

  it('rewrites current and daily logs without touching imports', async () => {
    const importsDir = join(historyDir, 'imports');
    mkdirSync(importsDir, { recursive: true });
    writeJsonl(join(historyDir, '2026-04-09.jsonl'), [
      entry('u1', 'user', 'old', '2026-04-09T12:00:00Z'),
      entry('a1', 'assistant', 'old reply', '2026-04-09T12:00:01Z'),
    ]);
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u2', 'user', 'new', '2026-04-10T12:00:00Z'),
      entry('a2', 'assistant', 'new reply', '2026-04-10T12:00:01Z'),
    ]);
    writeJsonl(join(importsDir, 'chatgpt.jsonl'), [
      entry('imp1', 'user', 'imported', '2026-04-10T12:00:02Z'),
    ]);

    const { rewindHistoryAfter, readEntries } = await import('./history.js');
    const result = rewindHistoryAfter('a1');

    expect(result.removed.map((m) => m.id)).toEqual(['u2', 'a2']);
    expect(readEntries(join(historyDir, '2026-04-09.jsonl')).map((e) => e.message.id)).toEqual(['u1', 'a1']);
    expect(readEntries(join(historyDir, 'current.jsonl'))).toEqual([]);
    expect(readEntries(join(importsDir, 'chatgpt.jsonl')).map((e) => e.message.id)).toEqual(['imp1']);
  });

  it('does not rewrite files when the target is missing', async () => {
    writeJsonl(join(historyDir, 'current.jsonl'), [
      entry('u1', 'user', 'hello', '2026-04-10T12:00:00Z'),
    ]);

    const { rewindHistoryAfter, readEntries } = await import('./history.js');
    const result = rewindHistoryAfter('missing');

    expect(result.targetFound).toBe(false);
    expect(result.removed).toEqual([]);
    expect(readEntries(join(historyDir, 'current.jsonl')).map((e) => e.message.id)).toEqual(['u1']);
  });
});
