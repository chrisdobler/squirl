import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, readHistory, seriesKey, toHistoryEntry, groupBySeries, type HistoryEntry } from './history.js';
import type { RunResult, Metrics } from './types.js';
import { DEFAULT_CHUNK_OPTIONS } from '../chunk.js';

const metrics = (recall5: number): Metrics => ({
  recallAtK: { 5: recall5 }, precisionAtK: {}, hitRateAtK: {}, ndcgAtK: { 10: 0.9 }, mrr: 1, numCases: 15,
});

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  timestamp: '2026-06-25T10:00:00Z', label: 'baseline', layer: 1, mode: 'frozen',
  embedderName: 'openai:BAAI/bge-large-en-v1.5', chunkHash: '0f392c7d',
  rank: { perQueryK: 8, recallK: 10, filterConversation: true }, metrics: metrics(1), ...over,
});

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eval-hist-')); path = join(dir, 'history.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('appendHistory / readHistory', () => {
  it('round-trips entries in order and creates the dir', () => {
    appendHistory(entry({ label: 'a' }), path);
    appendHistory(entry({ label: 'b' }), path);
    const out = readHistory(path);
    expect(out.map((e) => e.label)).toEqual(['a', 'b']);
    expect(out[0]!.metrics.recallAtK[5]).toBe(1);
  });

  it('returns [] for a missing file', () => {
    expect(readHistory(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('skips malformed lines instead of throwing', () => {
    appendHistory(entry({ label: 'good' }), path);
    // simulate a corrupt line
    appendHistory(entry({ label: 'good2' }), path);
    const out = readHistory(path);
    expect(out).toHaveLength(2);
  });
});

describe('seriesKey', () => {
  it('combines layer, mode, embedder, and chunk hash', () => {
    expect(seriesKey(entry())).toBe('1:frozen:openai:BAAI/bge-large-en-v1.5:0f392c7d');
  });

  it('differs across embedders so runs are not connected', () => {
    expect(seriesKey(entry({ embedderName: 'openai:text-embedding-3-small' })))
      .not.toBe(seriesKey(entry()));
  });
});

describe('groupBySeries', () => {
  it('buckets entries by series key, preserving order', () => {
    const groups = groupBySeries([
      entry({ label: 'a', layer: 1 }),
      entry({ label: 'b', layer: 2 }),
      entry({ label: 'c', layer: 1 }),
    ]);
    expect([...groups.keys()]).toHaveLength(2);
    expect(groups.get('1:frozen:openai:BAAI/bge-large-en-v1.5:0f392c7d')!.map((e) => e.label)).toEqual(['a', 'c']);
  });
});

describe('toHistoryEntry', () => {
  it('derives embedderName + chunkHash from the run config', () => {
    const result: RunResult = {
      config: {
        mode: 'frozen', layer: 3,
        embedder: { type: 'local', model: 'BAAI/bge-large-en-v1.5' },
        meta: { provider: 'local', model: 'm' },
        chunk: DEFAULT_CHUNK_OPTIONS,
        rank: { perQueryK: 8, recallK: 10, filterConversation: true },
        ks: [1, 5, 10], label: 'judge-run',
      },
      timestamp: '2026-06-25T12:00:00Z',
      perCase: [],
      metrics: metrics(0.8),
      judge: { wins: 6, losses: 2, ties: 1, meanScoreWithMemory: 4.2, meanScoreWithoutMemory: 2.8 },
    };
    const e = toHistoryEntry(result);
    expect(e.layer).toBe(3);
    expect(e.label).toBe('judge-run');
    expect(e.embedderName).toBe('openai:BAAI/bge-large-en-v1.5'); // matches OpenAIEmbedder.name format
    expect(e.chunkHash).toMatch(/^[0-9a-f]{8}$/);
    expect(e.judge!.wins).toBe(6);
    expect(e).not.toHaveProperty('perCase'); // history stays lean
  });
});
