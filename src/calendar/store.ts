import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CalendarSnapshot, GoogleCalendarClientCredentials, GoogleCalendarTokens, TaskCalendarSyncSnapshot } from './types.js';

export const calendarSnapshotPath = () => join(homedir(), '.squirl', 'calendar-activity.json');
export const calendarAuthPath = () => join(homedir(), '.squirl', 'google-calendar-auth.json');
export const calendarClientCredentialsPath = () => join(homedir(), '.squirl', 'google-calendar-client.json');
export const taskCalendarSyncPath = () => join(homedir(), '.squirl', 'calendar-task-sync.json');
export const calendarRepairAuditPath = (generatedAt = new Date().toISOString()) => join(homedir(), '.squirl', `calendar-task-repair-${generatedAt.replace(/[:.]/g, '-')}.json`);

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function saveCalendarSnapshot(value: CalendarSnapshot, path = calendarSnapshotPath()): void { atomicWrite(path, value); }
export function saveCalendarTokens(value: GoogleCalendarTokens, path = calendarAuthPath()): void { atomicWrite(path, value); }
export function saveCalendarClientCredentials(value: GoogleCalendarClientCredentials, path = calendarClientCredentialsPath()): void { atomicWrite(path, value); }
export function saveTaskCalendarSync(value: TaskCalendarSyncSnapshot, path = taskCalendarSyncPath()): void { atomicWrite(path, value); }
export function saveCalendarRepairAudit(value: unknown, path = calendarRepairAuditPath()): string { atomicWrite(path, value); return path; }
export function clearCalendarCredentials(path = calendarAuthPath()): void { rmSync(path, { force: true }); }
export function clearCalendarClientCredentials(path = calendarClientCredentialsPath()): void { rmSync(path, { force: true }); }
export function clearCalendarSnapshot(path = calendarSnapshotPath()): void { rmSync(path, { force: true }); }

export function loadCalendarSnapshot(path = calendarSnapshotPath()): CalendarSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as CalendarSnapshot;
    if (value.version !== 1 || !Number.isFinite(Date.parse(value.refreshedAt)) || !Array.isArray(value.calendars) || !Array.isArray(value.events)) return null;
    if (!value.events.every((event) => typeof event.calendarId === 'string' && typeof event.eventId === 'string' && typeof event.title === 'string' && Number.isFinite(Date.parse(event.startAt)) && Number.isFinite(Date.parse(event.endAt)))) return null;
    return value;
  } catch { return null; }
}

export function loadCalendarTokens(path = calendarAuthPath()): GoogleCalendarTokens | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GoogleCalendarTokens;
    return value.version === 1 && typeof value.refreshToken === 'string' && value.refreshToken ? value : null;
  } catch { return null; }
}

export function loadCalendarClientCredentials(path = calendarClientCredentialsPath()): GoogleCalendarClientCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GoogleCalendarClientCredentials;
    return value.version === 1 && typeof value.clientSecret === 'string' && value.clientSecret ? value : null;
  } catch { return null; }
}

export function loadTaskCalendarSync(path = taskCalendarSyncPath()): TaskCalendarSyncSnapshot {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as TaskCalendarSyncSnapshot;
    if (value.version !== 1 || !Array.isArray(value.entries)) return { version: 1, entries: [] };
    const valid = value.entries.every((entry) => entry && typeof entry.taskId === 'string' && typeof entry.title === 'string'
      && typeof entry.calendarId === 'string' && typeof entry.eventId === 'string' && Number.isFinite(Date.parse(entry.startAt))
      && Number.isFinite(Date.parse(entry.endAt)) && Number.isFinite(Date.parse(entry.lastSeenAt))
      && (entry.lastActiveAt == null || Number.isFinite(Date.parse(entry.lastActiveAt)))
      && (entry.missingSince == null || Number.isFinite(Date.parse(entry.missingSince))) && ['active', 'ended'].includes(entry.status));
    return valid ? value : { version: 1, entries: [] };
  } catch { return { version: 1, entries: [] }; }
}
