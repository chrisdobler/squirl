import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarClient } from './google.js';
import type { GoogleCalendarTokens } from './types.js';

describe('GoogleCalendarClient', () => {
  it('writes the task summary into Google Calendar event notes', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: 'event-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const tokens: GoogleCalendarTokens = { version: 1, accessToken: 'access', refreshToken: 'refresh', expiresAt: '2099-01-01T00:00:00Z' };
    const client = new GoogleCalendarClient(() => 'client', () => 'client-secret', () => tokens, () => undefined, request as typeof fetch);

    await client.createTaskEvent('primary', { taskId: 'task-1', title: 'Build Squirl', summary: 'Sync summaries to event notes.', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:30:00Z' });

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ summary: 'Build Squirl', description: 'Sync summaries to event notes.' });
  });

  it('uses PKCE, validates state, and stores the refresh credential', async () => {
    let tokens: GoogleCalendarTokens | null = null;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const value = String(input).includes('userinfo')
        ? { sub: 'user-1', email: 'chris@example.com', name: 'Chris' }
        : { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 };
      return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const client = new GoogleCalendarClient(() => 'client.apps.googleusercontent.com', () => 'client-secret', () => tokens, (value) => { tokens = value; }, request as typeof fetch);
    const authorizationUrl = new URL(client.authorizationUrl('http://127.0.0.1:4174'));
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(await client.completeAuthorization('code', authorizationUrl.searchParams.get('state')!)).toBe('http://127.0.0.1:4174');
    expect(tokens).toMatchObject({ refreshToken: 'refresh', profile: { id: 'user-1', email: 'chris@example.com', name: 'Chris' } });
    expect(String(requests[0]!.init?.body)).toContain('code_verifier=');
    expect(String(requests[0]!.init?.body)).toContain('client_secret=client-secret');
  });

  it('keeps the OAuth callback on the API origin while retaining a separate UI return origin', async () => {
    let tokens: GoogleCalendarTokens | null = null;
    const request = async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('userinfo')
      ? { sub: 'user-1', email: 'chris@example.com' }
      : { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const client = new GoogleCalendarClient(() => 'client.apps.googleusercontent.com', () => 'client-secret', () => tokens, (value) => { tokens = value; }, request as typeof fetch);
    const authorizationUrl = new URL(client.authorizationUrl('http://127.0.0.1:4174', 'http://127.0.0.1:5173'));
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4174/api/calendar/oauth/callback');
    expect(await client.completeAuthorization('code', authorizationUrl.searchParams.get('state')!)).toBe('http://127.0.0.1:5173');
  });

  it('enumerates calendars and preserves active duplicate events while excluding cancelled entries', async () => {
    const responses = [
      { items: [{ id: 'primary', summary: 'Main', primary: true }, { id: 'shared', summary: 'Shared' }] },
      { items: [
        { id: 'a', summary: 'Interview', status: 'confirmed', start: { dateTime: '2026-07-13T18:00:00Z' }, end: { dateTime: '2026-07-13T18:30:00Z' } },
        { id: 'b', summary: 'Interview', status: 'tentative', transparency: 'transparent', start: { dateTime: '2026-07-13T18:00:00Z' }, end: { dateTime: '2026-07-13T18:30:00Z' } },
        { id: 'c', summary: 'Gone', status: 'cancelled', start: { dateTime: '2026-07-13T18:00:00Z' }, end: { dateTime: '2026-07-13T18:30:00Z' } },
      ] },
    ];
    const request = async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const tokens = { version: 1 as const, refreshToken: 'r', accessToken: 'a', expiresAt: '2099-01-01T00:00:00Z' };
    const client = new GoogleCalendarClient(() => 'client', () => 'client-secret', () => tokens, () => undefined, request as typeof fetch);
    expect(await client.listCalendars([])).toEqual([{ id: 'primary', summary: 'Main', primary: true, selected: true }, { id: 'shared', summary: 'Shared', primary: false, selected: false }]);
    const events = await client.listEvents(['primary'], '2026-07-13T17:00:00Z', '2026-07-13T22:00:00Z');
    expect(events.map((event) => event.eventId)).toEqual(['a', 'b']);
  });

  it('creates and updates only explicitly marked Squirl task events', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'created-event' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const tokens = { version: 1 as const, refreshToken: 'r', accessToken: 'a', expiresAt: '2099-01-01T00:00:00Z' };
    const client = new GoogleCalendarClient(() => 'client', () => 'client-secret', () => tokens, () => undefined, request as typeof fetch);
    expect(await client.createTaskEvent('primary', { taskId: 'task-1', title: 'Build Squirl', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:05:00Z' })).toBe('created-event');
    await client.updateTaskEvent('primary', 'created-event', { taskId: 'task-1', title: 'Build Squirl', startAt: '2026-07-13T18:00:00Z', endAt: '2026-07-13T18:10:00Z' });
    expect(requests.map((entry) => entry.init?.method)).toEqual(['POST', 'PATCH']);
    expect(String(requests[0]!.init?.body)).toContain('"squirlManaged":"true"');
    expect(String(requests[1]!.init?.body)).toContain('"squirlTaskId":"task-1"');
  });
});
