import { createHash } from 'node:crypto';

import type { MetaLLM } from '../search/meta-extract.js';
import { recall } from '../search/recall.js';
import type { Embedder, SearchResult, VectorStore } from '../search/types.js';
import type { TaskActivityEvidence, TaskActivityItem, TaskActivitySnapshot } from './types.js';
import type { CalendarEventRecord } from '../calendar/types.js';

const SYSTEM_PROMPT = `/no_think
You are a JSON-only task activity classifier. Group recent activity by shared objective, even when several agents contributed. Semantic memories provide naming and continuity, but every returned task MUST cite at least one supplied recent evidence id. Do not create tasks supported only by memory.

Respond with exactly this JSON shape and no markdown:
{"confidence":"high|low","tasks":[{"title":"concise task title","summary":"one or two sentences explaining the objective and current state","evidenceIds":["recent-evidence-id"],"calendarEventIds":["calendar-evidence-id"]}]}

Summaries must be grounded in the supplied recent evidence and semantic memories. Explain what the project is trying to accomplish and what is currently happening; do not invent status, deadlines, or outcomes. Use confidence high only when the recent evidence and retrieved memories support a reliable view. Use an empty tasks array for non-task conversation.`;

interface RawTask {
  title?: unknown;
  summary?: unknown;
  evidenceIds?: unknown;
  calendarEventIds?: unknown;
}

interface RawClassification {
  confidence?: unknown;
  tasks?: unknown;
}

export class TaskClassificationError extends Error {}

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function taskId(title: string, evidenceIds: string[]): string {
  return `task-${createHash('sha1').update(`${title.toLowerCase()}\0${[...evidenceIds].sort().join('\0')}`).digest('hex').slice(0, 16)}`;
}

function classifierInput(evidence: TaskActivityEvidence[], calendarEvents: CalendarEventRecord[], memories: SearchResult[], previous: TaskActivitySnapshot | null): string {
  return JSON.stringify({
    recentEvidence: evidence.map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      user: compact(item.userText, 1_000),
      ...(item.assistantText ? { assistant: compact(item.assistantText, 1_500) } : {}),
      ...(item.toolSummary ? { tools: compact(item.toolSummary, 750) } : {}),
      participantIds: item.participantIds,
    })),
    calendarEvents: calendarEvents.map((event) => ({ id: `calendar:${event.calendarId}:${event.eventId}`, title: event.title, startAt: event.startAt, endAt: event.endAt })),
    semanticMemories: memories.map((result) => ({
      id: result.id,
      timestamp: result.turnPair.timestamp,
      user: compact(result.turnPair.userText, 500),
      assistant: compact(result.turnPair.assistantText, 750),
    })),
    previousTaskTitles: previous?.tasks.map((task) => task.title) ?? [],
  });
}

export async function classifyCurrentTasks(options: {
  evidence: TaskActivityEvidence[];
  llm: MetaLLM;
  embedder: Embedder;
  vectorStore: VectorStore;
  previous: TaskActivitySnapshot | null;
  now?: Date;
  recallK?: number;
  calendarEvents?: CalendarEventRecord[];
}): Promise<TaskActivitySnapshot> {
  const { evidence, llm, embedder, vectorStore, previous } = options;
  if (evidence.length === 0) {
    const generatedAt = (options.now ?? new Date()).toISOString();
    return { version: 2, generatedAt, sourceWatermark: 'empty', tasks: [] };
  }

  const query = evidence.slice(-8).map((item) => `${item.userText}\n${item.assistantText ?? ''}`).join('\n\n').slice(-6_000);
  const memories = await recall(query, embedder, vectorStore, options.recallK ?? 8);
  if (memories.length === 0) throw new TaskClassificationError('No relevant semantic memory was available.');

  const raw = await llm.complete({
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: classifierInput(evidence, options.calendarEvents ?? [], memories, previous) }],
  });
  let parsed: RawClassification;
  try {
    parsed = JSON.parse(raw.trim()) as RawClassification;
  } catch {
    throw new TaskClassificationError('The task classifier returned invalid JSON.');
  }
  if (parsed.confidence !== 'high' || !Array.isArray(parsed.tasks)) {
    throw new TaskClassificationError('The task classifier did not produce a high-confidence result.');
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const calendarIds = new Set((options.calendarEvents ?? []).map((event) => `calendar:${event.calendarId}:${event.eventId}`));
  const tasks: TaskActivityItem[] = [];
  for (const value of parsed.tasks as RawTask[]) {
    const title = typeof value?.title === 'string' ? compact(value.title, 96) : '';
    const summary = typeof value?.summary === 'string' ? compact(value.summary, 360) : '';
    const evidenceIds = Array.isArray(value?.evidenceIds)
      ? [...new Set(value.evidenceIds.filter((id): id is string => typeof id === 'string' && evidenceById.has(id)))]
      : [];
    if (!title || !summary || evidenceIds.length === 0) throw new TaskClassificationError('The task classifier returned an incomplete task or cited invalid recent evidence.');
    const rawCalendarIds = Array.isArray(value?.calendarEventIds) ? value.calendarEventIds.filter((id): id is string => typeof id === 'string') : [];
    if (rawCalendarIds.some((id) => !calendarIds.has(id))) throw new TaskClassificationError('The task classifier cited an unknown calendar event.');
    const calendarEventIds = [...new Set(rawCalendarIds)];
    const supporting = evidenceIds.map((id) => evidenceById.get(id)!);
    const lastActiveAt = supporting.map((item) => item.timestamp).sort().at(-1)!;
    const participantIds = [...new Set(supporting.flatMap((item) => item.participantIds))];
    tasks.push({ id: taskId(title, evidenceIds), title, summary, lastActiveAt, participantIds, evidenceIds, source: 'inferred', ...(calendarEventIds.length ? { calendarEventIds } : {}) });
  }

  tasks.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return {
    version: 2,
    generatedAt: (options.now ?? new Date()).toISOString(),
    sourceWatermark: `${evidence.at(-1)!.timestamp}:${evidence.at(-1)!.id}:${evidence.length}`,
    tasks,
  };
}
