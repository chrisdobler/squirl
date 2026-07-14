import { describe, expect, it } from 'vitest';

import type { MetaLLM } from '../search/meta-extract.js';
import type { Embedder, SearchResult, VectorStore } from '../search/types.js';
import { classifyCurrentTasks, TaskClassificationError } from './classifier.js';
import type { TaskActivityEvidence } from './types.js';

const evidence: TaskActivityEvidence[] = [
  { id: 'u1', timestamp: '2026-07-13T17:50:00.000Z', userText: 'build inferred tasks', participantIds: ['squirl'] },
  { id: 'u2', timestamp: '2026-07-13T17:55:00.000Z', userText: 'add it below agents', assistantText: 'implemented UI', participantIds: ['codex'] },
];

const memory: SearchResult = {
  id: 'memory-1', score: 0.9,
  turnPair: { id: 'memory-1', source: 'squirl', conversationId: 'history', timestamp: '2026-07-12T00:00:00.000Z', userText: 'sidebar work', assistantText: 'agent roster' },
};

const embedder = { name: 'fake', dimensions: 1, embed: async () => [[1]] } satisfies Embedder;
const store = (results: SearchResult[]) => ({ query: async () => results } as unknown as VectorStore);
const llm = (content: string): MetaLLM => ({ complete: async () => content });

describe('current task classifier', () => {
  it('groups an objective and derives activity metadata only from cited recent evidence', async () => {
    const result = await classifyCurrentTasks({
      evidence,
      embedder,
      vectorStore: store([memory]),
      llm: llm(JSON.stringify({ confidence: 'high', tasks: [{ title: 'Build durable current tasks', summary: 'Squirl is building a durable feed of active work and displaying it below the agent roster.', evidenceIds: ['u1', 'u2'] }] })),
      previous: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: 'Build durable current tasks',
      summary: 'Squirl is building a durable feed of active work and displaying it below the agent roster.',
      lastActiveAt: '2026-07-13T17:55:00.000Z',
      participantIds: ['squirl', 'codex'],
      evidenceIds: ['u1', 'u2'],
    });
  });

  it('requires relevant memory and high-confidence valid evidence', async () => {
    await expect(classifyCurrentTasks({ evidence, embedder, vectorStore: store([]), llm: llm('{}'), previous: null }))
      .rejects.toThrow('No relevant semantic memory');
    await expect(classifyCurrentTasks({ evidence, embedder, vectorStore: store([memory]), llm: llm('{"confidence":"low","tasks":[]}'), previous: null }))
      .rejects.toBeInstanceOf(TaskClassificationError);
    await expect(classifyCurrentTasks({ evidence, embedder, vectorStore: store([memory]), llm: llm('{"confidence":"high","tasks":[{"title":"Made up","summary":"Unsupported work.","evidenceIds":["missing"]}]}'), previous: null }))
      .rejects.toThrow('invalid recent evidence');
  });

  it('validates calendar evidence and retains semantic links for calendar-wins merging', async () => {
    const calendarEvents = [{ calendarId: 'primary', eventId: 'event-1', title: 'Squirl', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T19:00:00Z', allDay: false }];
    const valid = await classifyCurrentTasks({
      evidence, calendarEvents, embedder, vectorStore: store([memory]), previous: null,
      llm: llm('{"confidence":"high","tasks":[{"title":"Build Squirl","summary":"The current Squirl sidebar work is being implemented.","evidenceIds":["u2"],"calendarEventIds":["calendar:primary:event-1"]}]}'),
    });
    expect(valid.tasks[0]?.calendarEventIds).toEqual(['calendar:primary:event-1']);
    await expect(classifyCurrentTasks({
      evidence, calendarEvents, embedder, vectorStore: store([memory]), previous: null,
      llm: llm('{"confidence":"high","tasks":[{"title":"Build Squirl","summary":"The current Squirl sidebar work is being implemented.","evidenceIds":["u2"],"calendarEventIds":["calendar:primary:unknown"]}]}'),
    })).rejects.toThrow('unknown calendar event');
  });
});
