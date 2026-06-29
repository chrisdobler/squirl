import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { embedderName, chunkHashOf } from './harness.js';
import type { RankConfig, Metrics, JudgeSummary, RunResult } from './types.js';

export const EVAL_DIR = join(homedir(), '.squirl', 'eval');
export const HISTORY_PATH = join(EVAL_DIR, 'history.jsonl');

/** One run's compact summary — the unit of the trend timeline. No perCase (kept lean). */
export interface HistoryEntry {
  timestamp: string;
  label: string;
  layer: number;
  mode: string;
  embedderName: string;
  chunkHash: string;
  rank: RankConfig;
  metrics: Metrics;
  judge?: JudgeSummary;
}

/** Comparable-run grouping key: only runs sharing this should be connected on a trend line. */
export function seriesKey(e: Pick<HistoryEntry, 'layer' | 'mode' | 'embedderName' | 'chunkHash'>): string {
  return `${e.layer}:${e.mode}:${e.embedderName}:${e.chunkHash}`;
}

export function toHistoryEntry(result: RunResult): HistoryEntry {
  return {
    timestamp: result.timestamp,
    label: result.config.label,
    layer: result.config.layer,
    mode: result.config.mode,
    embedderName: embedderName(result.config.embedder),
    chunkHash: chunkHashOf(result.config.chunk),
    rank: result.config.rank,
    metrics: result.metrics,
    ...(result.judge ? { judge: result.judge } : {}),
  };
}

export function appendHistory(entry: HistoryEntry, filePath: string = HISTORY_PATH): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

export function readHistory(filePath: string = HISTORY_PATH): HistoryEntry[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as HistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is HistoryEntry => e !== null);
}

/** Bucket entries by seriesKey, preserving insertion order within each bucket. */
export function groupBySeries(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const groups = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const key = seriesKey(e);
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}
