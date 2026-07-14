import type { LogEntry } from '../history.js';
import type { MetaLLM } from '../search/meta-extract.js';
import type { Embedder, VectorStore } from '../search/types.js';
import { classifyCurrentTasks, TaskClassificationError } from './classifier.js';
import { buildTaskEvidenceForRange } from './evidence.js';
import type { ScrumBlocker, ScrumReport, TaskActivityEvidence, TaskActivityItem } from './types.js';

const DATE_USAGE = 'Usage: /scrum [yesterday|today|<weekday>|YYYY-MM-DD]';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export class ScrumInputError extends Error {}

export interface ScrumDateSelection {
  key: string;
  start: Date;
  end: Date;
  label: string;
}

function localDateStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function selection(date: Date): ScrumDateSelection {
  const start = localDateStart(date);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return {
    key: dateKey(start),
    start,
    end,
    label: new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(start),
  };
}

export function parseScrumDate(input = '', now = new Date()): ScrumDateSelection {
  const token = input.trim().toLowerCase() || 'yesterday';
  const today = localDateStart(now);
  let target: Date;

  if (token === 'today') {
    target = today;
  } else if (token === 'yesterday') {
    target = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  } else {
    const weekday = WEEKDAYS.indexOf(token as typeof WEEKDAYS[number]);
    if (weekday >= 0) {
      const daysBack = (today.getDay() - weekday + 7) % 7;
      target = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack);
    } else {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
      if (!match) throw new ScrumInputError(DATE_USAGE);
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      target = new Date(year, month - 1, day);
      if (target.getFullYear() !== year || target.getMonth() !== month - 1 || target.getDate() !== day) {
        throw new ScrumInputError(`Invalid calendar date "${input.trim()}". ${DATE_USAGE}`);
      }
    }
  }

  if (target.getTime() > today.getTime()) throw new ScrumInputError('Scrum reports cannot be generated for a future date.');
  return selection(target);
}

const BLOCKER_PROMPT = `/no_think
You are a JSON-only scrum blocker extractor. Return only blockers that are explicitly stated in the supplied activity evidence. Delays, failures, waiting on another person or system, and direct statements of being blocked qualify. Do not infer a blocker merely because work is unfinished or uncertain.

Respond with exactly this JSON shape and no markdown:
{"confidence":"high|low","blockers":[{"text":"concise explicit blocker","evidenceIds":["evidence-id"]}]}

Every blocker MUST cite at least one supplied evidence id. Use confidence high with an empty blockers array when there are no explicit blockers.`;

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function classifyExplicitBlockers(evidence: TaskActivityEvidence[], llm: MetaLLM): Promise<ScrumBlocker[]> {
  if (evidence.length === 0) return [];
  const raw = await llm.complete({
    systemPrompt: BLOCKER_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({ activityEvidence: evidence.map((item) => ({
        id: item.id,
        timestamp: item.timestamp,
        user: compact(item.userText, 1_000),
        ...(item.assistantText ? { assistant: compact(item.assistantText, 1_500) } : {}),
        ...(item.toolSummary ? { tools: compact(item.toolSummary, 750) } : {}),
      })) }),
    }],
  });

  let parsed: { confidence?: unknown; blockers?: unknown };
  try {
    parsed = JSON.parse(raw.trim()) as typeof parsed;
  } catch {
    throw new TaskClassificationError('The scrum blocker classifier returned invalid JSON.');
  }
  if (parsed.confidence !== 'high' || !Array.isArray(parsed.blockers)) {
    throw new TaskClassificationError('The scrum blocker classifier did not produce a high-confidence result.');
  }

  const evidenceIds = new Set(evidence.map((item) => item.id));
  return parsed.blockers.map((value: unknown) => {
    const blocker = value as { text?: unknown; evidenceIds?: unknown };
    const text = typeof blocker?.text === 'string' ? compact(blocker.text, 240) : '';
    const cited = Array.isArray(blocker?.evidenceIds)
      ? [...new Set(blocker.evidenceIds.filter((id): id is string => typeof id === 'string' && evidenceIds.has(id)))]
      : [];
    if (!text || cited.length === 0) throw new TaskClassificationError('The scrum blocker classifier cited invalid activity evidence.');
    return { text, evidenceIds: cited };
  });
}

export async function generateScrumReport(options: {
  input?: string;
  entries: LogEntry[];
  currentTasks: TaskActivityItem[];
  llm: MetaLLM;
  embedder: Embedder;
  vectorStore: VectorStore;
  now?: Date;
  recallK?: number;
}): Promise<ScrumReport> {
  const now = options.now ?? new Date();
  const requested = parseScrumDate(options.input, now);
  const today = selection(now);
  const requestedEvidence = buildTaskEvidenceForRange(options.entries, requested.start, requested.end);
  const todayEvidence = requested.key === today.key
    ? requestedEvidence
    : buildTaskEvidenceForRange(options.entries, today.start, now.getTime() + 1);

  const requestedTasks = requested.key === today.key
    ? options.currentTasks
    : (await classifyCurrentTasks({
      evidence: requestedEvidence,
      llm: options.llm,
      embedder: options.embedder,
      vectorStore: options.vectorStore,
      previous: null,
      now,
      recallK: options.recallK,
    })).tasks;
  const blockerEvidence = requested.key === today.key
    ? requestedEvidence
    : [...requestedEvidence, ...todayEvidence.filter((item) => !requestedEvidence.some((candidate) => candidate.id === item.id))];
  const blockers = await classifyExplicitBlockers(blockerEvidence, options.llm);

  return {
    requestedDate: requested.key,
    requestedLabel: requested.label,
    requestedTasks,
    todayDate: today.key,
    todayTasks: options.currentTasks,
    blockers,
  };
}

function formatTasks(tasks: TaskActivityItem[]): string {
  if (tasks.length === 0) return '- No activity found.';
  return tasks.map((task) => `- **${task.title}**${task.summary ? ` — ${task.summary}` : ''}`).join('\n');
}

export function formatScrumReport(report: ScrumReport): string {
  const isToday = report.requestedDate === report.todayDate;
  const [year, month, day] = report.todayDate.split('-').map(Number);
  const yesterday = new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
  const requestedHeading = isToday ? 'Today' : report.requestedDate === yesterday ? 'Yesterday' : report.requestedLabel;
  const sections = [`## ${requestedHeading}\n${formatTasks(report.requestedTasks)}`];
  if (!isToday) sections.push(`## Today\n${formatTasks(report.todayTasks)}`);
  sections.push(`## Blockers\n${report.blockers.length ? report.blockers.map((blocker) => `- ${blocker.text}`).join('\n') : '- No explicit blockers found.'}`);
  return `# Scrum — ${report.requestedLabel}\n\n${sections.join('\n\n')}`;
}

export { DATE_USAGE as SCRUM_DATE_USAGE };
