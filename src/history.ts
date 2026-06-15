import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Message } from './types.js';

interface LogEntry {
  timestamp: string;
  message: Message;
}

export interface RewindHistoryResult {
  targetFound: boolean;
  removed: Message[];
  retained: Message[];
}

const HISTORY_DIR = join(homedir(), '.squirl', 'history');
const IMPORTS_DIR = join(HISTORY_DIR, 'imports');
const CURRENT_LOG = join(HISTORY_DIR, 'current.jsonl');
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 50;

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

function getDailyFiles(): string[] {
  ensureDir();
  return readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.jsonl') && f !== 'current.jsonl')
    .sort()
    .reverse();
}

function getImportFiles(): string[] {
  mkdirSync(IMPORTS_DIR, { recursive: true });
  return readdirSync(IMPORTS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
}

function writeEntries(filePath: string, entries: LogEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(filePath, lines ? lines + '\n' : '', 'utf-8');
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
 * Load chat history: roll over old entries, backfill from archives if needed.
 * Always returns up to MAX_HISTORY most recent messages.
 */
export function loadHistory(): Message[] {
  ensureDir();
  const entries = readEntries(CURRENT_LOG);
  const recent = rollover(entries);

  const all: LogEntry[] = [...recent];

  for (const file of getDailyFiles()) {
    const daily = readEntries(join(HISTORY_DIR, file));
    all.push(...daily);
  }

  for (const file of getImportFiles()) {
    const imported = readEntries(join(IMPORTS_DIR, file));
    all.push(...imported);
  }

  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all.slice(-MAX_HISTORY).map((e) => e.message);
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
 * Permanently remove Squirl-owned history entries after targetMessageId.
 * A null target rewinds before the first writable message, removing all
 * current/daily Squirl history while leaving imported archives untouched.
 */
export function rewindHistoryAfter(targetMessageId: string | null): RewindHistoryResult {
  ensureDir();

  const files = getAllHistoryFiles();
  const byFile = new Map<string, LogEntry[]>();
  const all: Array<LogEntry & { filePath: string; originalIndex: number }> = [];

  for (const filePath of files) {
    const entries = readEntries(filePath);
    byFile.set(filePath, entries);
    entries.forEach((entry, originalIndex) => {
      all.push({ ...entry, filePath, originalIndex });
    });
  }

  all.sort((a, b) => {
    const byTime = a.timestamp.localeCompare(b.timestamp);
    if (byTime !== 0) return byTime;
    const byFileName = a.filePath.localeCompare(b.filePath);
    if (byFileName !== 0) return byFileName;
    return a.originalIndex - b.originalIndex;
  });

  const targetIndex = targetMessageId === null
    ? -1
    : all.findIndex((entry) => entry.message.id === targetMessageId);

  if (targetIndex === -1 && targetMessageId !== null) {
    return {
      targetFound: false,
      removed: [],
      retained: all.map((entry) => entry.message),
    };
  }

  const retainedEntries = all.slice(0, targetIndex + 1);
  const retainedKeys = new Set(retainedEntries.map((entry) => `${entry.filePath}:${entry.originalIndex}`));
  const removedEntries = all.slice(targetIndex + 1);

  for (const [filePath, entries] of byFile) {
    const nextEntries = entries.filter((_entry, index) => retainedKeys.has(`${filePath}:${index}`));
    writeEntries(filePath, nextEntries);
  }

  return {
    targetFound: true,
    removed: removedEntries.map((entry) => entry.message),
    retained: retainedEntries.map((entry) => entry.message),
  };
}

/**
 * Append a message to an import-specific log file.
 */
export function appendImportMessage(message: Message, source: string, timestamp?: string): void {
  mkdirSync(IMPORTS_DIR, { recursive: true });
  const entry: LogEntry = {
    timestamp: timestamp ?? new Date().toISOString(),
    message,
  };
  appendFileSync(join(IMPORTS_DIR, `${source}.jsonl`), JSON.stringify(entry) + '\n', 'utf-8');
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
  writeEntries(CURRENT_LOG, entries);
}
