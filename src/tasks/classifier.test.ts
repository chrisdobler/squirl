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
const queuedLlm = (...contents: string[]): MetaLLM => ({ complete: async () => contents.shift() ?? '{}' });

describe('current task classifier', () => {
  it('groups an objective and derives activity metadata only from cited recent evidence', async () => {
    const result = await classifyCurrentTasks({
      evidence,
      embedder,
      vectorStore: store([memory]),
      llm: llm(JSON.stringify({ confidence: 'high', tasks: [{ title: 'Improve durable task visibility', summary: 'Squirl is building a durable feed of active work and displaying it below the agent roster.', evidenceIds: ['u1', 'u2'], previousTaskIds: [] }] })),
      previous: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: 'Improve durable task visibility',
      summary: 'Squirl is building a durable feed of active work and displaying it below the agent roster.',
      lastActiveAt: '2026-07-13T17:55:00.000Z',
      participantIds: ['squirl', 'codex'],
      evidenceIds: ['u1', 'u2'],
    });
  });

  it('uses recent evidence when semantic memory has no results', async () => {
    const result = await classifyCurrentTasks({
      evidence, embedder, vectorStore: store([]), previous: null,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve durable task visibility","summary":"Squirl is improving the active-work feed.","evidenceIds":["u1"],"previousTaskIds":[]}]}'),
    });
    expect(result).toMatchObject({ version: 3, tasks: [{ title: 'Improve durable task visibility' }] });
  });

  it('bounds classifier context and accepts a safe JSON response envelope', async () => {
    const manyEvidence = Array.from({ length: 10 }, (_, index) => ({
      id: `u${index}`, timestamp: `2026-07-13T17:${String(40 + index).padStart(2, '0')}:00.000Z`,
      userText: `task evidence ${index}`, participantIds: ['squirl'],
    }));
    const manyMemories = Array.from({ length: 6 }, (_, index) => ({
      ...memory, id: `memory-${index}`, turnPair: { ...memory.turnPair, id: `memory-${index}` },
    }));
    const result = await classifyCurrentTasks({
      evidence: manyEvidence, embedder, vectorStore: store(manyMemories), previous: null,
      llm: { complete: async ({ messages }) => {
        const input = JSON.parse(messages[0]!.content);
        expect(input.recentEvidence).toHaveLength(8);
        expect(input.recentEvidence[0].id).toBe('u2');
        expect(input.semanticMemories).toHaveLength(4);
        return '<think>internal notes</think>\n```json\n{"confidence":"high","tasks":[{"title":"Research durable voice options","summary":"The bounded classifier input retains the newest task evidence.","evidenceIds":["u9"],"previousTaskIds":[]}]}\n```';
      } },
    });
    expect(result.tasks[0]?.title).toBe('Research durable voice options');
  });

  it('requires high-confidence valid evidence', async () => {
    await expect(classifyCurrentTasks({ evidence, embedder, vectorStore: store([memory]), llm: llm('{"confidence":"low","tasks":[]}'), previous: null }))
      .rejects.toBeInstanceOf(TaskClassificationError);
    await expect(classifyCurrentTasks({ evidence, embedder, vectorStore: store([memory]), llm: llm('{"confidence":"high","tasks":[{"title":"Invent unsupported task","summary":"Unsupported work.","evidenceIds":["missing"]}]}'), previous: null }))
      .rejects.toThrow('invalid recent evidence');
  });

  it('refines an existing task in place and accumulates its continuity evidence', async () => {
    const previous = {
      version: 2 as const, generatedAt: '2026-07-13T17:50:00.000Z', sourceWatermark: 'old',
      tasks: [{ id: 'task-stable', title: 'Improve task feed', summary: 'Initial task feed work.', lastActiveAt: evidence[0]!.timestamp, participantIds: ['squirl'], evidenceIds: ['older-evidence'], source: 'inferred' as const }],
    };
    const result = await classifyCurrentTasks({
      evidence, previous,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve durable task visibility","summary":"The existing task feed is being refined with durable activity details.","evidenceIds":["u2"],"previousTaskIds":["task-stable"]}]}'),
    });
    expect(result.tasks).toEqual([expect.objectContaining({
      id: 'task-stable', title: 'Improve durable task visibility',
      evidenceIds: ['older-evidence', 'u2'], participantIds: ['squirl', 'codex'],
    })]);
  });

  it('retains a unique canonical task id when the model omits continuity metadata', async () => {
    const previous = {
      version: 3 as const, generatedAt: evidence[0]!.timestamp, sourceWatermark: 'old',
      tasks: [{
        id: 'voice-task', title: 'Research open-source voice options', lastActiveAt: evidence[0]!.timestamp,
        participantIds: ['squirl'], evidenceIds: ['u1'], calendarEventIds: ['calendar:primary:voice-event'],
      }],
    };
    const calendarEvents = [{ calendarId: 'primary', eventId: 'voice-event', title: 'Voice research', startAt: '2026-07-13T17:00:00Z', endAt: '2026-07-13T18:00:00Z', allDay: false, squirlTaskId: 'voice-task' }];
    const byTitle = await classifyCurrentTasks({
      evidence, previous, calendarEvents,
      llm: llm('{"confidence":"high","tasks":[{"title":"Research open-source voice options","summary":"The same voice research continues with updated sources.","evidenceIds":["u2"],"previousTaskIds":[]}]}'),
    });
    expect(byTitle.tasks[0]).toMatchObject({ id: 'voice-task', evidenceIds: ['u1', 'u2'] });

    const byCalendar = await classifyCurrentTasks({
      evidence, previous, calendarEvents,
      llm: llm('{"confidence":"high","tasks":[{"title":"Compare self-hosted speech engines","summary":"The voice research is being refined around self-hosted engines.","evidenceIds":["u2"],"calendarEventIds":["calendar:primary:voice-event"],"previousTaskIds":[]}]}'),
    });
    expect(byCalendar.tasks[0]?.id).toBe('voice-task');
  });

  it('does not guess continuity when multiple existing tasks match', async () => {
    const previous = {
      version: 3 as const, generatedAt: evidence[0]!.timestamp, sourceWatermark: 'old',
      tasks: [
        { id: 'voice-a', title: 'Research open-source voice options', lastActiveAt: evidence[0]!.timestamp, participantIds: ['squirl'], evidenceIds: [] },
        { id: 'voice-b', title: 'Research open-source voice options', lastActiveAt: evidence[0]!.timestamp, participantIds: ['codex'], evidenceIds: [] },
      ],
    };
    const result = await classifyCurrentTasks({
      evidence, previous,
      llm: llm('{"confidence":"high","tasks":[{"title":"Research open-source voice options","summary":"A separately evidenced voice objective is active.","evidenceIds":["u2"],"previousTaskIds":[]}]}'),
    });
    expect(result.tasks[0]?.id).not.toBe('voice-a');
    expect(result.tasks[0]?.id).not.toBe('voice-b');
  });

  it('merges duplicate existing tasks and supports distinct concurrent objectives', async () => {
    const previous = {
      version: 3 as const, generatedAt: evidence[0]!.timestamp, sourceWatermark: 'old',
      tasks: [
        { id: 'duplicate-a', title: 'Improve task titles', lastActiveAt: evidence[0]!.timestamp, participantIds: ['squirl'], evidenceIds: ['a'] },
        { id: 'duplicate-b', title: 'Fix current tasks', lastActiveAt: evidence[0]!.timestamp, participantIds: ['codex'], evidenceIds: ['b'] },
      ],
    };
    const result = await classifyCurrentTasks({
      evidence, previous,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve current-task title quality","summary":"Duplicate title work is one shared objective.","evidenceIds":["u1"],"previousTaskIds":["duplicate-a","duplicate-b"]},{"title":"Correct calendar event timing","summary":"A separate calendar timing objective is active concurrently.","evidenceIds":["u2"],"previousTaskIds":[]}]}'),
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks).toContainEqual(expect.objectContaining({ id: 'duplicate-a', title: 'Improve current-task title quality', participantIds: ['squirl', 'codex'] }));
    expect(result.tasks.find((task) => task.title === 'Correct calendar event timing')?.id).toMatch(/^task-/);
  });

  it('repairs a generic resume title once and rejects repeated junk', async () => {
    const bad = '{"confidence":"high","tasks":[{"title":"Resume previous task","summary":"Resuming earlier work.","evidenceIds":["u1"],"previousTaskIds":[]}]}';
    const repaired = '{"confidence":"high","tasks":[{"title":"Improve current-task title quality","summary":"The task naming path is being corrected.","evidenceIds":["u1"],"previousTaskIds":[]}]}';
    const result = await classifyCurrentTasks({ evidence, previous: null, llm: queuedLlm(bad, repaired) });
    expect(result.tasks[0]?.title).toBe('Improve current-task title quality');
    await expect(classifyCurrentTasks({ evidence, previous: null, llm: queuedLlm(bad, bad) }))
      .rejects.toThrow('poor title');
  });

  it('rejects unknown or multiply claimed continuity ids', async () => {
    const previous = {
      version: 3 as const, generatedAt: evidence[0]!.timestamp, sourceWatermark: 'old',
      tasks: [{ id: 'known', title: 'Improve task titles', lastActiveAt: evidence[0]!.timestamp, participantIds: [], evidenceIds: [] }],
    };
    await expect(classifyCurrentTasks({
      evidence, previous,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve current-task title quality","summary":"One objective.","evidenceIds":["u1"],"previousTaskIds":["missing"]}]}'),
    })).rejects.toThrow('unknown existing task');
    await expect(classifyCurrentTasks({
      evidence, previous,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve current-task title quality","summary":"One objective.","evidenceIds":["u1"],"previousTaskIds":["known"]},{"title":"Correct calendar event timing","summary":"Another objective.","evidenceIds":["u2"],"previousTaskIds":["known"]}]}'),
    })).rejects.toThrow('reused an existing task');
  });

  it('validates calendar evidence and retains semantic links for calendar-wins merging', async () => {
    const calendarEvents = [{ calendarId: 'primary', eventId: 'event-1', title: 'Squirl', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T19:00:00Z', allDay: false }];
    const valid = await classifyCurrentTasks({
      evidence, calendarEvents, embedder, vectorStore: store([memory]), previous: null,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve Squirl sidebar tasks","summary":"The current Squirl sidebar work is being implemented.","evidenceIds":["u2"],"calendarEventIds":["calendar:primary:event-1"],"previousTaskIds":[]}]}'),
    });
    expect(valid.tasks[0]?.calendarEventIds).toEqual(['calendar:primary:event-1']);
    await expect(classifyCurrentTasks({
      evidence, calendarEvents, embedder, vectorStore: store([memory]), previous: null,
      llm: llm('{"confidence":"high","tasks":[{"title":"Improve Squirl sidebar tasks","summary":"The current Squirl sidebar work is being implemented.","evidenceIds":["u2"],"calendarEventIds":["calendar:primary:unknown"],"previousTaskIds":[]}]}'),
    })).rejects.toThrow('unknown calendar event');
  });

  it('prunes contradictory Squirl-managed calendar links from continued tasks', async () => {
    const previous = {
      version: 3 as const, generatedAt: evidence[0]!.timestamp, sourceWatermark: 'old',
      tasks: [{ id: 'voice', title: 'Research open-source voice options', lastActiveAt: evidence[0]!.timestamp, participantIds: [], evidenceIds: ['u1'], calendarEventIds: ['calendar:primary:voice', 'calendar:primary:scrum'] }],
    };
    const calendarEvents = [
      { calendarId: 'primary', eventId: 'voice', title: 'Research open-source voice options', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:30:00Z', allDay: false, squirlTaskId: 'voice-old' },
      { calendarId: 'primary', eventId: 'scrum', title: 'Implement Scrum timeout fix', startAt: '2026-07-13T17:00:00Z', endAt: '2026-07-13T17:30:00Z', allDay: false, squirlTaskId: 'scrum' },
    ];
    const result = await classifyCurrentTasks({
      evidence, previous, calendarEvents,
      llm: llm('{"confidence":"high","tasks":[{"title":"Research open-source voice options","summary":"The existing voice research continues.","evidenceIds":["u2"],"calendarEventIds":["calendar:primary:scrum"],"previousTaskIds":["voice"]}]}'),
    });
    expect(result.tasks[0]?.calendarEventIds).toEqual(['calendar:primary:voice']);
  });
});
