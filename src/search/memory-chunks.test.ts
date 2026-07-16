import { describe, expect, it } from 'vitest';
import { chunksForMessage, MEMORY_CHUNK_MAX_CHARS, splitMemoryContent } from './memory-chunks.js';

describe('semantic memory chunks', () => {
  it('preserves the tail of long agent output across bounded chunks', () => {
    const ending = 'FINAL RECOMMENDATION: use LiveKit Agents or Pipecat.';
    const chunks = splitMemoryContent(`${'research '.repeat(300)}${ending}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MEMORY_CHUNK_MAX_CHARS)).toBe(true);
    expect(chunks.join('\n')).toContain(ending);
  });

  it('adds short user context but never indexes tool chatter', () => {
    const user = { id: 'u1', role: 'user' as const, content: 'What are the best voice options?' };
    const chunks = chunksForMessage({
      roomId: 'room', timestamp: '2026-07-14T00:00:00Z', contextMessage: user,
      message: { id: 'a1', role: 'assistant', participantId: 'cc-squirl-fable', content: 'Use LiveKit.' },
    });
    expect(chunks[0]).toMatchObject({ contextMessageId: 'u1', contextText: user.content, participantId: 'cc-squirl-fable' });
    expect(chunksForMessage({ roomId: 'room', timestamp: '', message: { id: 't1', role: 'tool', toolCallId: 'x', toolName: 'Bash', content: 'noise' } })).toEqual([]);
    expect(chunksForMessage({ roomId: 'room', timestamp: '', message: {
      id: 'activity-1', role: 'activity', content: 'operational noise', participantId: 'cc-squirl-fable',
      activity: { version: 1, kind: 'research', state: 'running', title: 'Researching', participantId: 'cc-squirl-fable', updatedAt: '2026-07-14T00:00:00Z', actions: [] },
    } })).toEqual([]);
  });
});
