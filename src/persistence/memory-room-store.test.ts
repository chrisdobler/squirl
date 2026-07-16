import { describe, expect, it } from 'vitest';
import { MemoryRoomStore } from './memory-room-store.js';
import { createTurnPipelineTrace, finishTurnPipelineTrace } from '../pipeline-trace.js';

describe('MemoryRoomStore message identity', () => {
  it('separates insertion from validated in-place updates', async () => {
    const store = new MemoryRoomStore();
    const message = { id: 'message-1', role: 'assistant' as const, participantId: 'claude', content: 'first' };
    await store.insertMessage(message, 'turn-1', '2026-07-14T00:00:00Z');
    const before = (await store.loadMessages())[0]!;
    await expect(store.insertMessage({ ...message, content: 'collision' })).rejects.toThrow('Message id collision');
    await expect(store.updateMessage({ ...message, participantId: 'codex' }, 'turn-1')).rejects.toThrow('Message identity mismatch');
    await expect(store.updateMessage({ ...message, content: 'wrong turn' }, 'turn-2')).rejects.toThrow('Message identity mismatch');
    await store.updateMessage({ ...message, content: 'updated', responseMeta: { model: 'local', confidence: 63 } }, 'turn-1');
    const after = (await store.loadMessages())[0]!;
    expect(after).toMatchObject({
      sequence: before.sequence, timelineOrder: before.timelineOrder, timestamp: before.timestamp, turnId: 'turn-1',
      message: { content: 'updated', responseMeta: { model: 'local', confidence: 63 } },
    });
  });

  it('reports unresolved counter ids without misclassifying UUIDs', async () => {
    const store = new MemoryRoomStore();
    await store.insertMessage({ id: 'codex-squirl-1', role: 'assistant', content: 'legacy' });
    await store.insertMessage({ id: '0f7ee018-e6a3-48ab-95f1-773804666165', role: 'assistant', content: 'uuid' });
    expect(await store.auditMessageOrder()).toEqual({ ambiguousLegacyIds: ['codex-squirl-1'] });
  });

  it('keeps only the newest ten pipeline traces and removes rewound response traces', async () => {
    const store = new MemoryRoomStore();
    for (let index = 0; index < 11; index++) {
      const assistantMessageId = `assistant-${index}`;
      await store.insertMessage({ id: assistantMessageId, role: 'assistant', content: `answer ${index}` });
      const trace = finishTurnPipelineTrace({
        ...createTurnPipelineTrace(`turn-${index}`, `request ${index}`),
        assistantMessageId,
        startedAt: new Date(Date.UTC(2026, 6, 16, 0, index)).toISOString(),
      }, 'succeeded');
      await store.savePipelineTrace(trace, 10);
    }
    const retained = await store.loadRecentPipelineTraces(10);
    expect(retained).toHaveLength(10);
    expect(retained.map((trace) => trace.turnId)).toEqual(Array.from({ length: 10 }, (_, index) => `turn-${10 - index}`));

    await store.rewindAfter('assistant-8');
    expect((await store.loadRecentPipelineTraces(10)).map((trace) => trace.assistantMessageId)).not.toContain('assistant-9');
    expect((await store.loadRecentPipelineTraces(10)).map((trace) => trace.assistantMessageId)).not.toContain('assistant-10');
  });
});
