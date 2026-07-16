import { createHash } from 'node:crypto';

import type { MetaLLM } from '../search/meta-extract.js';
import { recall } from '../search/recall.js';
import type { Embedder, SearchResult, VectorStore } from '../search/types.js';
import type { CalendarEventRecord } from '../calendar/types.js';
import { normalizeTaskTitle } from './continuity.js';
import type { TaskActivityEvidence, TaskActivityItem, TaskActivitySnapshot } from './types.js';

const SYSTEM_PROMPT = `/no_think
You are a JSON-only current-task reconciler. Decide whether recent activity continues existing active work, adds detail to it, merges duplicate tasks, or establishes genuinely distinct objectives being worked on concurrently.

Default to refining one existing task when messages are follow-ups, corrections, status updates, investigation steps, or collaboration toward the same outcome. Return multiple tasks only when the evidence clearly supports separate objectives being pursued concurrently. Several agents may contribute to one task.

Every task title must describe a specific intended outcome, not an activity status. Use concrete wording such as "Correct Codex reset-time reporting". Never use placeholders such as "Resume previous task", "Continue work", "Current task", "Work on this", or context-free pronouns. Do not claim the outcome is complete. Summaries should explain the objective and current state in one or two evidence-grounded sentences.

For continued work, include the known existing task id in previousTaskIds. Include multiple ids when the result merges duplicate existing tasks. Do not reuse one previous id in multiple results. Use an empty array only for a genuinely new objective.

Respond with exactly this JSON shape and no markdown:
{"confidence":"high|low","tasks":[{"title":"specific outcome-focused title","summary":"objective and current state","evidenceIds":["recent-evidence-id"],"calendarEventIds":["calendar-evidence-id"],"previousTaskIds":["known-existing-task-id"]}]}

Every returned task MUST cite at least one supplied recent evidence id. Semantic memories are optional naming context and cannot support a task by themselves. Use confidence high only when the supplied evidence supports the task count, continuity, title, and summary. Use an empty tasks array for non-task conversation.`;

interface RawTask {
  title?: unknown;
  summary?: unknown;
  evidenceIds?: unknown;
  calendarEventIds?: unknown;
  previousTaskIds?: unknown;
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

function newTaskId(evidenceIds: string[]): string {
  return `task-${createHash('sha1').update(evidenceIds.slice().sort().join('\0')).digest('hex').slice(0, 16)}`;
}

export function taskTitleProblem(value: string): string | null {
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) return 'title is empty';
  if (title.length > 96) return 'title exceeds 96 characters';
  if (title.split(/\s+/).length < 3) return 'title is too vague';
  if (/^(?:resume|continue|continuing|working?|delegated)\b/i.test(title)) return 'title describes activity status instead of an outcome';
  if (/^(?:current|previous|delegated)\s+(?:task|work)$/i.test(title)) return 'title is a generic placeholder';
  if (/^(?:fix|review|investigate|update|improve|correct|build|create|add|remove|determine|diagnose|resolve|implement)\s+(?:it|this|that|issue|task|work|thing|problem)$/i.test(title)) return 'title lacks a specific object';
  if (/\b(?:task (?:it|they|he|she) was doing before|the previous task)\b/i.test(title)) return 'title refers to prior work without naming it';
  return null;
}

function classifierInput(evidence: TaskActivityEvidence[], calendarEvents: CalendarEventRecord[], memories: SearchResult[], previous: TaskActivitySnapshot | null): string {
  const recentEvidence = evidence.slice(-8);
  return JSON.stringify({
    recentEvidence: recentEvidence.map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      user: compact(item.userText, 1_000),
      ...(item.assistantText ? { assistant: compact(item.assistantText, 1_500) } : {}),
      ...(item.toolSummary ? { tools: compact(item.toolSummary, 750) } : {}),
      participantIds: item.participantIds,
    })),
    calendarEvents: calendarEvents.map((event) => ({ id: `calendar:${event.calendarId}:${event.eventId}`, title: event.title, startAt: event.startAt, endAt: event.endAt })),
    semanticMemories: memories.slice(0, 4).map((result) => ({
      id: result.id,
      timestamp: result.turnPair.timestamp,
      user: compact(result.turnPair.userText, 500),
      assistant: compact(result.turnPair.assistantText, 750),
    })),
    existingTasks: previous?.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      summary: task.summary,
      lastActiveAt: task.lastActiveAt,
      participantIds: task.participantIds,
      evidenceIds: task.evidenceIds,
    })) ?? [],
  });
}

function parseClassification(raw: string): RawClassification {
  const withoutThinking = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
  const candidates = [withoutThinking];
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const firstBrace = withoutThinking.indexOf('{');
  const lastBrace = withoutThinking.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutThinking.slice(firstBrace, lastBrace + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate) as RawClassification;
    } catch {
      // Try the next safe JSON envelope before reporting a classifier failure.
    }
  }
  throw new TaskClassificationError('The task classifier returned invalid JSON.');
}

function rawTitleProblems(parsed: RawClassification): string[] {
  if (!Array.isArray(parsed.tasks)) return [];
  return parsed.tasks.flatMap((value, index) => {
    const task = value as RawTask;
    const problem = typeof task?.title === 'string' ? taskTitleProblem(task.title) : 'title is missing';
    return problem ? [`tasks[${index}]: ${problem}`] : [];
  });
}

function reconcileTasks(
  parsed: RawClassification,
  evidence: TaskActivityEvidence[],
  calendarEvents: CalendarEventRecord[],
  previous: TaskActivitySnapshot | null,
): TaskActivityItem[] {
  if (parsed.confidence !== 'high' || !Array.isArray(parsed.tasks)) {
    throw new TaskClassificationError('The task classifier did not produce a high-confidence result.');
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const previousById = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const calendarById = new Map(calendarEvents.map((event) => [`calendar:${event.calendarId}:${event.eventId}`, event]));
  const calendarIds = new Set(calendarById.keys());
  const claimedPreviousIds = new Set<string>();
  const tasks: TaskActivityItem[] = [];

  for (const value of parsed.tasks as RawTask[]) {
    const title = typeof value?.title === 'string' ? compact(value.title, 96) : '';
    const titleProblem = taskTitleProblem(title);
    if (titleProblem) throw new TaskClassificationError(`The task classifier returned a poor title: ${titleProblem}.`);
    const summary = typeof value?.summary === 'string' ? compact(value.summary, 360) : '';
    const evidenceIds = Array.isArray(value?.evidenceIds)
      ? [...new Set(value.evidenceIds.filter((id): id is string => typeof id === 'string' && evidenceById.has(id)))]
      : [];
    if (!summary || evidenceIds.length === 0) throw new TaskClassificationError('The task classifier returned an incomplete task or cited invalid recent evidence.');

    const rawCalendarIds = Array.isArray(value?.calendarEventIds) ? value.calendarEventIds.filter((id): id is string => typeof id === 'string') : [];
    if (rawCalendarIds.some((id) => !calendarIds.has(id))) throw new TaskClassificationError('The task classifier cited an unknown calendar event.');

    const rawPreviousIds = Array.isArray(value?.previousTaskIds) ? value.previousTaskIds.filter((id): id is string => typeof id === 'string') : [];
    if (rawPreviousIds.some((id) => !previousById.has(id))) throw new TaskClassificationError('The task classifier cited an unknown existing task.');
    let previousTaskIds = [...new Set(rawPreviousIds)];
    if (previousTaskIds.length === 0) {
      const evidenceIdSet = new Set(evidenceIds);
      const calendarIdSet = new Set(rawCalendarIds);
      const candidates = (previous?.tasks ?? []).filter((task) => {
        if (claimedPreviousIds.has(task.id)) return false;
        const exactTitle = normalizeTaskTitle(task.title) === normalizeTaskTitle(title);
        const evidenceContinues = task.evidenceIds.some((id) => evidenceIdSet.has(id));
        const calendarContinues = (task.calendarEventIds ?? []).some((id) => calendarIdSet.has(id))
          || calendarEvents.some((event) => event.squirlTaskId === task.id && calendarIdSet.has(`calendar:${event.calendarId}:${event.eventId}`));
        return exactTitle || evidenceContinues || calendarContinues;
      });
      if (candidates.length === 1) previousTaskIds = [candidates[0]!.id];
    }
    if (previousTaskIds.some((id) => claimedPreviousIds.has(id))) throw new TaskClassificationError('The task classifier reused an existing task across multiple results.');
    previousTaskIds.forEach((id) => claimedPreviousIds.add(id));

    const continued = previousTaskIds.map((id) => previousById.get(id)!);
    const continuedIdSet = new Set(previousTaskIds);
    const calendarEventIds = [...new Set([...continued.flatMap((task) => task.calendarEventIds ?? []), ...rawCalendarIds])]
      .filter((id) => {
        const event = calendarById.get(id);
        if (!event) return false;
        if (!event.squirlTaskId) return true;
        return continuedIdSet.has(event.squirlTaskId) || normalizeTaskTitle(event.title) === normalizeTaskTitle(title);
      });
    const supporting = evidenceIds.map((id) => evidenceById.get(id)!);
    const lastActiveAt = supporting.map((item) => item.timestamp).sort().at(-1)!;
    const participantIds = [...new Set([...continued.flatMap((task) => task.participantIds), ...supporting.flatMap((item) => item.participantIds)])];
    const accumulatedEvidenceIds = [...new Set([...continued.flatMap((task) => task.evidenceIds), ...evidenceIds])];
    const id = previousTaskIds[0] ?? newTaskId(evidenceIds);
    tasks.push({
      id,
      title,
      summary,
      lastActiveAt,
      participantIds,
      evidenceIds: accumulatedEvidenceIds,
      source: 'inferred',
      ...(calendarEventIds.length ? { calendarEventIds } : {}),
    });
  }

  tasks.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return tasks;
}

export async function classifyCurrentTasks(options: {
  evidence: TaskActivityEvidence[];
  llm: MetaLLM;
  embedder?: Embedder | null;
  vectorStore?: VectorStore | null;
  previous: TaskActivitySnapshot | null;
  now?: Date;
  recallK?: number;
  calendarEvents?: CalendarEventRecord[];
}): Promise<TaskActivitySnapshot> {
  const { evidence, llm, previous } = options;
  if (evidence.length === 0) {
    const generatedAt = (options.now ?? new Date()).toISOString();
    return { version: 3, generatedAt, sourceWatermark: 'empty', tasks: [] };
  }

  const query = evidence.slice(-8).map((item) => `${item.userText}\n${item.assistantText ?? ''}`).join('\n\n').slice(-6_000);
  let memories: SearchResult[] = [];
  if (options.embedder && options.vectorStore) {
    try {
      memories = await recall(query, options.embedder, options.vectorStore, options.recallK ?? 8);
    } catch {
      memories = [];
    }
  }
  const input = classifierInput(evidence, options.calendarEvents ?? [], memories, previous);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: input }];
  let raw = await llm.complete({ systemPrompt: SYSTEM_PROMPT, messages });
  let parsed = parseClassification(raw);
  const problems = rawTitleProblems(parsed);
  if (problems.length > 0) {
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: `Repair the titles and return the complete JSON again. Validation failures: ${problems.join('; ')}` });
    raw = await llm.complete({ systemPrompt: SYSTEM_PROMPT, messages });
    parsed = parseClassification(raw);
  }

  const tasks = reconcileTasks(parsed, evidence, options.calendarEvents ?? [], previous);
  return {
    version: 3,
    generatedAt: (options.now ?? new Date()).toISOString(),
    sourceWatermark: `${evidence.at(-1)!.timestamp}:${evidence.at(-1)!.id}:${evidence.length}`,
    tasks,
  };
}
