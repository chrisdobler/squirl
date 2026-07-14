import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LogEntry } from '../history.js';
import type { MetaLLM } from '../search/meta-extract.js';
import type { Embedder, SearchResult, VectorStore } from '../search/types.js';
import { classifyExplicitBlockers, formatScrumReport, generateScrumReport, parseScrumDate, ScrumInputError } from './scrum.js';
import type { TaskActivityItem } from './types.js';

const previousTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const embedder = { name: 'fake', dimensions: 1, embed: async () => [[1]] } satisfies Embedder;
const memory: SearchResult = {
  id: 'memory', score: 1,
  turnPair: { id: 'memory', source: 'squirl', conversationId: 'history', timestamp: '2026-07-01T00:00:00.000Z', userText: 'scrum work', assistantText: 'task context' },
};
const vectorStore = { query: async () => [memory] } as unknown as VectorStore;

function entry(timestamp: string, id: string, role: 'user' | 'assistant', content: string): LogEntry {
  return { timestamp, message: { id, role, content } };
}

function queuedLlm(...responses: string[]): MetaLLM {
  return { complete: async () => responses.shift() ?? '' };
}

const todayTask: TaskActivityItem = {
  id: 'today-task', title: 'Ship current task feed', summary: 'The live feed is being finished.',
  lastActiveAt: '2026-07-13T17:30:00.000Z', participantIds: ['codex'], evidenceIds: ['today-u'], source: 'inferred',
};

describe('scrum dates', () => {
  const now = new Date('2026-07-13T12:00:00-07:00');

  it('defaults to yesterday and resolves the most recent weekday including today', () => {
    expect(parseScrumDate('', now).key).toBe('2026-07-12');
    expect(parseScrumDate('monday', now).key).toBe('2026-07-13');
    expect(parseScrumDate('sunday', now).key).toBe('2026-07-12');
  });

  it('validates strict dates and rejects future dates', () => {
    expect(() => parseScrumDate('2026-02-30', now)).toThrow(ScrumInputError);
    expect(() => parseScrumDate('next week', now)).toThrow('Usage: /scrum');
    expect(() => parseScrumDate('2026-07-14', now)).toThrow('future date');
  });

  it('uses local calendar boundaries across daylight-saving transitions', () => {
    const spring = parseScrumDate('2026-03-08', now);
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe('scrum classification and formatting', () => {
  it('groups requested-day work, keeps the live today feed, and validates explicit blockers', async () => {
    const llm = queuedLlm(
      JSON.stringify({ confidence: 'high', tasks: [{ title: 'Build scrum reports', summary: 'The daily report path was implemented.', evidenceIds: ['yesterday-u'] }] }),
      JSON.stringify({ confidence: 'high', blockers: [{ text: 'Waiting for the index service.', evidenceIds: ['today-u'] }] }),
    );
    const report = await generateScrumReport({
      input: 'yesterday',
      entries: [
        entry('2026-07-12T17:00:00.000Z', 'yesterday-u', 'user', 'build the scrum report'),
        entry('2026-07-12T17:30:00.000Z', 'yesterday-a', 'assistant', 'implemented the report'),
        entry('2026-07-13T17:00:00.000Z', 'today-u', 'user', 'I am blocked waiting for the index service'),
      ],
      currentTasks: [todayTask], llm, embedder, vectorStore,
      now: new Date('2026-07-13T12:00:00-07:00'),
    });

    expect(report.requestedTasks).toEqual([expect.objectContaining({ title: 'Build scrum reports', evidenceIds: ['yesterday-u'] })]);
    expect(report.todayTasks).toEqual([todayTask]);
    expect(report.blockers).toEqual([{ text: 'Waiting for the index service.', evidenceIds: ['today-u'] }]);
    expect(formatScrumReport(report)).toContain('## Yesterday');
    expect(formatScrumReport(report)).toContain('## Today\n- **Ship current task feed**');
  });

  it('does not duplicate Today and renders explicit empty states', async () => {
    const report = await generateScrumReport({
      input: 'today', entries: [], currentTasks: [], llm: queuedLlm(), embedder, vectorStore,
      now: new Date('2026-07-13T12:00:00-07:00'),
    });
    const output = formatScrumReport(report);
    expect(output.match(/^## Today$/gm)).toHaveLength(1);
    expect(output).toContain('No activity found.');
    expect(output).toContain('No explicit blockers found.');
  });

  it('rejects blockers that are not grounded in supplied evidence', async () => {
    await expect(classifyExplicitBlockers([
      { id: 'real', timestamp: '2026-07-13T17:00:00.000Z', userText: 'working', participantIds: [] },
    ], queuedLlm(JSON.stringify({ confidence: 'high', blockers: [{ text: 'Invented blocker', evidenceIds: ['missing'] }] }))))
      .rejects.toThrow('invalid activity evidence');
  });
});
