import type { AgentActivityProgress } from '../types.js';

export interface WorkflowTerminalState {
  state: 'completed' | 'failed' | 'cancelled';
  error?: string;
  completedAt?: string;
}

export interface WorkflowWorkerState {
  id: string;
  key: string;
  state: 'running' | 'completed';
}

export interface WorkflowJournalStatus {
  progress: AgentActivityProgress;
  workers: WorkflowWorkerState[];
}

export const WORKFLOW_STALL_GRACE_MS = 2 * 60_000;

/**
 * Silence alone is never enough to call work stalled. We require both stale
 * provider evidence and an authoritative local liveness check showing that the
 * matching workflow process is gone.
 */
export function workflowIsStalled(input: {
  now: number;
  startedAt?: string;
  lastActivityAt?: string;
  providerProcessRunning?: boolean;
  graceMs?: number;
}): boolean {
  if (input.providerProcessRunning !== false) return false;
  const startedAt = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const lastActivityAt = input.lastActivityAt ? Date.parse(input.lastActivityAt) : Number.NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastActivityAt)) return false;
  const graceMs = input.graceMs ?? WORKFLOW_STALL_GRACE_MS;
  return input.now - startedAt >= graceMs && input.now - lastActivityAt >= graceMs;
}

export function workflowResumePrompt(input: { taskId: string; runId: string; scriptPath: string; workflowArgs?: string }): string {
  const invocation = input.workflowArgs
    ? `Invoke Workflow immediately with exactly this input: ${JSON.stringify({ scriptPath: input.scriptPath, resumeFromRunId: input.runId, args: input.workflowArgs })}. Do not call any other tools first.`
    : `Invoke Workflow with scriptPath ${JSON.stringify(input.scriptPath)}, resumeFromRunId ${JSON.stringify(input.runId)}, and the recovered original args.`;
  return [
    `Continue the interrupted background workflow for task ${input.taskId}.`,
    ...(input.workflowArgs ? [] : ['Recover the exact original Workflow args from the cached scope result or provider transcript before invoking the workflow; args are mandatory and must be byte-for-byte equivalent to the original research question so cache keys match.']),
    invocation,
    'Inspect the existing journal, reuse its cached completed results, rerun only unfinished workers, and wait for an authoritative terminal provider status.',
    'Do not claim completion or synthesize the final answer until that terminal status is confirmed.',
  ].join(' ');
}

/** Journal rows are progress evidence only. They never establish workflow completion. */
export function workflowStatusFromJournal(content: string): WorkflowJournalStatus {
  const started = new Map<string, string>();
  const finished = new Set<string>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; key?: unknown };
      if (typeof entry.key !== 'string') continue;
      const agentId = (entry as { agentId?: unknown }).agentId;
      if (entry.type === 'started' && typeof agentId === 'string') started.set(entry.key, agentId);
      if (entry.type === 'result') finished.add(entry.key);
    } catch { /* A partially written journal row is not authoritative. */ }
  }
  return {
    progress: { completed: finished.size, active: Math.max(0, started.size - finished.size), phase: 'Background workflow' },
    workers: [...started].map(([key, id]) => ({ id, key, state: finished.has(key) ? 'completed' as const : 'running' as const })),
  };
}

export function workflowProgressFromJournal(content: string): AgentActivityProgress {
  return workflowStatusFromJournal(content).progress;
}

function recordsWithin(value: unknown, limit = 200): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length && records.length < limit) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    records.push(record);
    pending.push(...Object.values(record));
  }
  return records;
}

/** Requires an explicit provider task id and terminal status in the same structured record. */
export function explicitWorkflowTerminalState(content: string, taskId: string): WorkflowTerminalState | null {
  for (const line of content.split('\n')) {
    if (!line.includes(taskId)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    for (const candidate of recordsWithin(parsed)) {
      const candidateTaskId = candidate.taskId ?? candidate.task_id;
      const status = candidate.status ?? candidate.taskStatus ?? candidate.task_status;
      const notification = typeof candidate.content === 'string' && candidate.content.includes('<task-notification>')
        ? {
          taskId: candidate.content.match(/<task-id>([^<]+)<\/task-id>/)?.[1],
          status: candidate.content.match(/<status>([^<]+)<\/status>/)?.[1],
        }
        : undefined;
      const resolvedTaskId = candidateTaskId ?? notification?.taskId;
      const resolvedStatus = status ?? notification?.status;
      if (resolvedTaskId !== taskId || typeof resolvedStatus !== 'string') continue;
      const completedAt = typeof candidate.timestamp === 'string' ? candidate.timestamp
        : parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).timestamp === 'string'
          ? (parsed as Record<string, unknown>).timestamp as string : undefined;
      if (resolvedStatus === 'completed' || resolvedStatus === 'succeeded') return { state: 'completed', ...(completedAt ? { completedAt } : {}) };
      if (resolvedStatus === 'failed' || resolvedStatus === 'error') {
        return { state: 'failed', ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}) };
      }
      if (resolvedStatus === 'cancelled' || resolvedStatus === 'canceled') return { state: 'cancelled' };
    }
  }
  return null;
}
