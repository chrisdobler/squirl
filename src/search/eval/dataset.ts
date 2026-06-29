import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES_DIR } from './harness.js';
import type { TurnPair } from '../types.js';
import type { EvalCase } from './types.js';

/** Parse JSONL, ignoring blank lines. */
export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export async function loadCorpus(): Promise<TurnPair[]> {
  return parseJsonl<TurnPair>(await readFile(join(FIXTURES_DIR, 'corpus.jsonl'), 'utf8'));
}

export async function loadCases(): Promise<EvalCase[]> {
  return parseJsonl<EvalCase>(await readFile(join(FIXTURES_DIR, 'cases.jsonl'), 'utf8'));
}

/** Every gold query across all cases (deduped by the caller as needed). */
export function goldQueriesOf(cases: EvalCase[]): string[] {
  return cases.flatMap((c) => c.goldQueries ?? []);
}
