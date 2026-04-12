import { messagesToTurnPairs } from './turn-pair.js';
import type { IngestQueue } from './ingest-queue.js';
import type { VectorStore } from './types.js';
import type { Message } from '../types.js';

interface LogEntry {
  timestamp: string;
  message: Message;
}

export async function backfillFromHistory(
  queue: IngestQueue,
  store: Pick<VectorStore, 'has'>,
  entries: LogEntry[],
): Promise<void> {
  const messages = entries.map((e) => e.message);
  const pairs = messagesToTurnPairs(messages, 'history', 'squirl');
  if (pairs.length === 0) return;

  const existing = await store.has(pairs.map((p) => p.id));
  const newPairs = pairs.filter((p) => !existing.has(p.id));
  for (const pair of newPairs) queue.enqueue(pair);
}
