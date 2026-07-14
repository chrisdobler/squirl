import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCalendarClientCredentials, loadCalendarSnapshot, loadCalendarTokens, loadTaskCalendarSync, saveCalendarClientCredentials, saveCalendarSnapshot, saveCalendarTokens, saveTaskCalendarSync } from './store.js';

describe('calendar persistence', () => {
  it('atomically stores minimal snapshots and credentials with restrictive permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squirl-calendar-'));
    const snapshotPath = join(dir, 'calendar.json'); const authPath = join(dir, 'auth.json');
    const snapshot = { version: 1 as const, refreshedAt: '2026-07-13T18:00:00Z', calendars: [], events: [{ calendarId: 'p', eventId: 'e', title: 'Focus', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T19:00:00Z', allDay: false }] };
    const clientPath = join(dir, 'client.json');
    const syncPath = join(dir, 'sync.json');
    saveCalendarSnapshot(snapshot, snapshotPath); saveCalendarTokens({ version: 1, refreshToken: 'secret' }, authPath); saveCalendarClientCredentials({ version: 1, clientSecret: 'client-secret' }, clientPath);
    expect(loadCalendarSnapshot(snapshotPath)).toEqual(snapshot);
    expect(loadCalendarTokens(authPath)?.refreshToken).toBe('secret');
    expect(loadCalendarClientCredentials(clientPath)?.clientSecret).toBe('client-secret');
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(statSync(clientPath).mode & 0o777).toBe(0o600);
    saveTaskCalendarSync({ version: 1, entries: [{ taskId: 't', title: 'Focus', calendarId: 'p', eventId: 'e', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:05:00Z', lastSeenAt: '2026-07-13T18:05:00Z', status: 'active' }] }, syncPath);
    expect(loadTaskCalendarSync(syncPath).entries[0]?.eventId).toBe('e');
    expect(statSync(syncPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(snapshotPath, 'utf8')).not.toContain('secret');
  });
});
