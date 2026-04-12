import { describe, it, expect, vi } from 'vitest';
import { backfillFromHistory } from './backfill.js';
import type { IngestQueue } from './ingest-queue.js';
import type { VectorStore } from './types.js';

describe('backfillFromHistory', () => {
  it('reads entries, extracts turn-pairs, filters existing, enqueues new', async () => {
    const enqueueFn = vi.fn();
    const mockQueue = { enqueue: enqueueFn } as unknown as IngestQueue;
    const mockStore: Pick<VectorStore, 'has'> = {
      has: vi.fn().mockResolvedValue(new Set()),
    };

    const entries = [
      { timestamp: '2026-01-01T00:00:00Z', message: { id: 'u1', role: 'user' as const, content: 'hi' } },
      { timestamp: '2026-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant' as const, content: 'hello' } },
    ];

    await backfillFromHistory(mockQueue, mockStore, entries);

    expect(enqueueFn).toHaveBeenCalledTimes(1);
    expect(enqueueFn.mock.calls[0]![0].userText).toBe('hi');
  });

  it('skips turn-pairs already in the store', async () => {
    const enqueueFn = vi.fn();
    const mockQueue = { enqueue: enqueueFn } as unknown as IngestQueue;
    const mockStore: Pick<VectorStore, 'has'> = {
      has: vi.fn().mockImplementation(async (ids: string[]) => new Set(ids)),
    };

    const entries = [
      { timestamp: '2026-01-01T00:00:00Z', message: { id: 'u1', role: 'user' as const, content: 'hi' } },
      { timestamp: '2026-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant' as const, content: 'hello' } },
    ];

    await backfillFromHistory(mockQueue, mockStore, entries);
    expect(enqueueFn).not.toHaveBeenCalled();
  });
});
