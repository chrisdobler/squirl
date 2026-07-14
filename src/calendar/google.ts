import { createHash, randomBytes } from 'node:crypto';

import type { CalendarDescriptor, CalendarEventRecord, GoogleCalendarTokens, GoogleUserProfile } from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://www.googleapis.com/calendar/v3';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const SCOPE = `openid email profile https://www.googleapis.com/auth/calendar.readonly ${CALENDAR_WRITE_SCOPE}`;

type FetchLike = typeof fetch;
type PendingAuth = { state: string; verifier: string; redirectUri: string; returnUri: string; expiresAt: number };

function base64Url(value: Buffer): string { return value.toString('base64url'); }
function localMidnight(value: string): string { return new Date(`${value}T00:00:00`).toISOString(); }
function checkedOrigin(value: string): string {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Calendar OAuth must use a loopback Squirl URL.');
  return url.origin;
}

export class GoogleCalendarClient {
  private pending: PendingAuth | null = null;
  constructor(
    private readonly clientId: () => string | undefined,
    private readonly clientSecret: () => string | undefined,
    private readonly readTokens: () => GoogleCalendarTokens | null,
    private readonly writeTokens: (tokens: GoogleCalendarTokens) => void,
    private readonly request: FetchLike = fetch,
  ) {}

  authorizationUrl(callbackOrigin: string, returnOrigin = callbackOrigin): string {
    const id = this.clientId()?.trim();
    if (!id) throw new Error('Add a Google OAuth client ID in Calendar settings first.');
    const verifier = base64Url(randomBytes(48));
    const state = base64Url(randomBytes(24));
    const callbackBase = checkedOrigin(callbackOrigin);
    const returnUri = checkedOrigin(returnOrigin);
    const redirectUri = `${callbackBase}/api/calendar/oauth/callback`;
    this.pending = { state, verifier, redirectUri, returnUri, expiresAt: Date.now() + 10 * 60_000 };
    const params = new URLSearchParams({
      client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', state,
      code_challenge: base64Url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${params}`;
  }

  async completeAuthorization(code: string, state: string): Promise<string> {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.state !== state || pending.expiresAt < Date.now()) throw new Error('Calendar authorization state is invalid or expired.');
    const response = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_id: this.clientId() ?? '', client_secret: this.clientSecret() ?? '', code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, grant_type: 'authorization_code',
    }) });
    const value = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string };
    if (!response.ok || !value.refresh_token) throw new Error(value.error_description || 'Google did not return a refresh credential.');
    const profile = await this.fetchProfile(value.access_token ?? '');
    this.writeTokens({ version: 1, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: new Date(Date.now() + (value.expires_in ?? 3600) * 1000).toISOString(), profile, scopes: value.scope?.split(/\s+/).filter(Boolean) ?? [] });
    return pending.returnUri;
  }

  private async accessToken(): Promise<string> {
    let tokens = this.readTokens();
    if (!tokens) throw new Error('Google Calendar authorization is required.');
    if (tokens.accessToken && (!tokens.expiresAt || Date.parse(tokens.expiresAt) > Date.now() + 60_000)) return tokens.accessToken;
    const response = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_id: this.clientId() ?? '', client_secret: this.clientSecret() ?? '', refresh_token: tokens.refreshToken, grant_type: 'refresh_token',
    }) });
    const value = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !value.access_token) throw new Error(value.error_description || 'Google Calendar authorization could not be refreshed.');
    tokens = { ...tokens, accessToken: value.access_token, expiresAt: new Date(Date.now() + (value.expires_in ?? 3600) * 1000).toISOString() };
    this.writeTokens(tokens);
    return value.access_token;
  }

  private async fetchProfile(accessToken: string): Promise<GoogleUserProfile> {
    const response = await this.request(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const value = await response.json() as { sub?: string; email?: string; name?: string; picture?: string; error_description?: string };
    if (!response.ok || !value.sub || !value.email) throw new Error(value.error_description || 'Google did not return a usable account profile.');
    return { id: value.sub, email: value.email, ...(value.name ? { name: value.name } : {}), ...(value.picture ? { picture: value.picture } : {}) };
  }

  async ensureProfile(): Promise<GoogleUserProfile> {
    const current = this.readTokens();
    if (current?.profile) return current.profile;
    if (!current) throw new Error('Google sign-in is required.');
    const profile = await this.fetchProfile(await this.accessToken());
    this.writeTokens({ ...(this.readTokens() ?? current), profile });
    return profile;
  }

  private async get(path: string): Promise<any> {
    const response = await this.request(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    const value = await response.json();
    if (!response.ok) throw new Error((value as any)?.error?.message || `Google Calendar request failed (${response.status}).`);
    return value;
  }

  private async mutate(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<any> {
    const response = await this.request(`${API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error((value as any)?.error?.message || `Google Calendar write failed (${response.status}).`);
    return value;
  }

  async createTaskEvent(calendarId: string, task: { taskId: string; title: string; startAt: string; endAt: string }): Promise<string> {
    const value = await this.mutate('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary: task.title,
      start: { dateTime: task.startAt },
      end: { dateTime: task.endAt },
      extendedProperties: { private: { squirlManaged: 'true', squirlTaskId: task.taskId } },
    });
    if (typeof value.id !== 'string') throw new Error('Google Calendar did not return an event id.');
    return value.id;
  }

  async updateTaskEvent(calendarId: string, eventId: string, task: { taskId: string; title: string; startAt: string; endAt: string }): Promise<void> {
    await this.mutate('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      summary: task.title,
      start: { dateTime: task.startAt },
      end: { dateTime: task.endAt },
      extendedProperties: { private: { squirlManaged: 'true', squirlTaskId: task.taskId } },
    });
  }

  async listCalendars(selectedIds: string[]): Promise<CalendarDescriptor[]> {
    const items: any[] = [];
    let pageToken = '';
    do {
      const value = await this.get(`/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      items.push(...(Array.isArray(value.items) ? value.items : []));
      pageToken = typeof value.nextPageToken === 'string' ? value.nextPageToken : '';
    } while (pageToken);
    return items.filter((item) => typeof item.id === 'string').map((item) => ({
      id: item.id, summary: typeof item.summary === 'string' ? item.summary : item.id,
      primary: item.primary === true, selected: selectedIds.length ? selectedIds.includes(item.id) : item.primary === true,
    }));
  }

  async listEvents(calendarIds: string[], timeMin: string, timeMax: string): Promise<CalendarEventRecord[]> {
    const events: CalendarEventRecord[] = [];
    for (const calendarId of calendarIds) {
      let pageToken = '';
      do {
        const query = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
        if (pageToken) query.set('pageToken', pageToken);
        const value = await this.get(`/calendars/${encodeURIComponent(calendarId)}/events?${query}`);
        for (const item of Array.isArray(value.items) ? value.items : []) {
          if (item.status === 'cancelled' || typeof item.id !== 'string') continue;
          const allDay = typeof item.start?.date === 'string';
          const startAt = item.start?.dateTime ?? (allDay ? localMidnight(item.start.date) : null);
          const endAt = item.end?.dateTime ?? (typeof item.end?.date === 'string' ? localMidnight(item.end.date) : null);
          if (!startAt || !endAt || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) continue;
          const squirlTaskId = typeof item.extendedProperties?.private?.squirlTaskId === 'string' ? item.extendedProperties.private.squirlTaskId : undefined;
          events.push({ calendarId, eventId: item.id, title: typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : '(untitled event)', startAt, endAt, allDay, ...(squirlTaskId ? { squirlTaskId } : {}) });
        }
        pageToken = typeof value.nextPageToken === 'string' ? value.nextPageToken : '';
      } while (pageToken);
    }
    return events;
  }
}
