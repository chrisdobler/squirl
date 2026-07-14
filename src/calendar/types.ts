export interface CalendarDescriptor {
  id: string;
  summary: string;
  primary: boolean;
  selected: boolean;
}

export interface CalendarEventRecord {
  calendarId: string;
  eventId: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  squirlTaskId?: string;
}

export interface CalendarSnapshot {
  version: 1;
  refreshedAt: string;
  calendars: CalendarDescriptor[];
  events: CalendarEventRecord[];
}

export interface GoogleCalendarTokens {
  version: 1;
  accessToken?: string;
  refreshToken: string;
  expiresAt?: string;
  profile?: GoogleUserProfile;
  scopes?: string[];
}

export interface TaskCalendarSyncEntry {
  taskId: string;
  title: string;
  summary?: string;
  calendarId: string;
  eventId: string;
  startAt: string;
  endAt: string;
  lastSeenAt: string;
  /** Latest user-evidence timestamp that was classified into this task. */
  lastActiveAt?: string;
  status: 'active' | 'ended';
}

export interface TaskCalendarSyncSnapshot {
  version: 1;
  entries: TaskCalendarSyncEntry[];
}

export interface GoogleCalendarClientCredentials {
  version: 1;
  clientSecret: string;
}

export interface GoogleUserProfile {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}
