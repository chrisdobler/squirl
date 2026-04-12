import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Message } from './types.js';

interface LogEntry {
  timestamp: string;
  message: Message;
}

const HISTORY_DIR = join(homedir(), '.squirl', 'history');
const CURRENT_LOG = join(HISTORY_DIR, 'current.jsonl');
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

export function readEntries(filePath: string): LogEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').flatMap((line) => {
    try { return [JSON.parse(line) as LogEntry]; }
    catch { return []; }
  });
}

export function getAllHistoryFiles(): string[] {
  ensureDir();
  return readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(HISTORY_DIR, f));
}

function dateKey(timestamp: string): string {
  return timestamp.slice(0, 10); // YYYY-MM-DD
}

/**
 * Move entries older than 24h from current.jsonl into daily files.
 * Returns the recent entries that remain in current.jsonl.
 */
function rollover(entries: LogEntry[]): LogEntry[] {
  const cutoff = new Date(Date.now() - TWENTY_FOUR_HOURS).toISOString();
  const recent: LogEntry[] = [];
  const old = new Map<string, LogEntry[]>();

  for (const entry of entries) {
    if (entry.timestamp >= cutoff) {
      recent.push(entry);
    } else {
      const key = dateKey(entry.timestamp);
      const bucket = old.get(key) ?? [];
      bucket.push(entry);
      old.set(key, bucket);
    }
  }

  // Append old entries to their daily files
  for (const [date, bucket] of old) {
    const dailyPath = join(HISTORY_DIR, `${date}.jsonl`);
    const lines = bucket.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(dailyPath, lines, 'utf-8');
  }

  // Rewrite current.jsonl with only recent entries
  if (old.size > 0) {
    const lines = recent.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(CURRENT_LOG, lines ? lines + '\n' : '', 'utf-8');
  }

  return recent;
}

/**
 * Load chat history: roll over old entries, return recent messages.
 */
export function loadHistory(): Message[] {
  ensureDir();
  const entries = readEntries(CURRENT_LOG);
  const recent = rollover(entries);
  return recent.map((e) => e.message);
}

/**
 * Append a single message to the current log.
 */
export function appendMessage(message: Message): void {
  ensureDir();
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    message,
  };
  appendFileSync(CURRENT_LOG, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Update the last entry in current.jsonl (for finalizing streamed messages).
 * Rewrites the file — only call when streaming completes.
 */
export function updateLastMessage(message: Message): void {
  ensureDir();
  const entries = readEntries(CURRENT_LOG);
  if (entries.length === 0) return;
  const last = entries[entries.length - 1];
  if (last && last.message.id === message.id) {
    entries[entries.length - 1] = { timestamp: last.timestamp, message };
  }
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(CURRENT_LOG, lines + '\n', 'utf-8');
}
