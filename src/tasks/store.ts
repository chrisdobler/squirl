import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { TaskActivityItem, TaskActivitySnapshot } from './types.js';

export function taskActivityPath(): string {
  return join(homedir(), '.squirl', 'task-activity.json');
}

function isTask(value: unknown): value is TaskActivityItem {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TaskActivityItem>;
  return typeof task.id === 'string'
    && typeof task.title === 'string'
    && typeof task.lastActiveAt === 'string'
    && Number.isFinite(Date.parse(task.lastActiveAt))
    && Array.isArray(task.participantIds)
    && task.participantIds.every((id) => typeof id === 'string')
    && Array.isArray(task.evidenceIds)
    && task.evidenceIds.every((id) => typeof id === 'string');
}

export function loadTaskActivitySnapshot(path = taskActivityPath()): TaskActivitySnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TaskActivitySnapshot>;
    if (value.version !== 1 || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) || typeof value.sourceWatermark !== 'string') return null;
    if (!Array.isArray(value.tasks) || !value.tasks.every(isTask)) return null;
    return value as TaskActivitySnapshot;
  } catch {
    return null;
  }
}

export function saveTaskActivitySnapshot(snapshot: TaskActivitySnapshot, path = taskActivityPath()): void {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
