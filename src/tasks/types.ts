export interface TaskActivityItem {
  id: string;
  title: string;
  summary?: string;
  lastActiveAt: string;
  participantIds: string[];
  evidenceIds: string[];
  source?: 'inferred' | 'calendar';
  calendarEventIds?: string[];
  calendar?: {
    calendarId: string;
    eventId: string;
    startAt: string;
    endAt: string;
    allDay: boolean;
    managedBySquirl?: boolean;
  };
}

export type TaskActivityStatus = 'refreshing' | 'ready' | 'stale' | 'unavailable';

export interface TaskActivityState {
  tasks: TaskActivityItem[];
  generatedAt: string | null;
  status: TaskActivityStatus;
  error: string | null;
  calendar: {
    status: 'disconnected' | 'authorization-required' | 'refreshing' | 'ready' | 'stale';
    connected: boolean;
    canWrite: boolean;
    clientConfigured: boolean;
    selectionRequired: boolean;
    profile: { id: string; email: string; name?: string; picture?: string } | null;
    calendars: Array<{ id: string; summary: string; primary: boolean; selected: boolean }>;
    refreshedAt: string | null;
  };
}

export interface TaskActivitySnapshot {
  version: 1 | 2 | 3;
  generatedAt: string;
  sourceWatermark: string;
  tasks: TaskActivityItem[];
}

export interface TaskActivityEvidence {
  id: string;
  timestamp: string;
  userText: string;
  assistantText?: string;
  toolSummary?: string;
  participantIds: string[];
}

export interface ScrumBlocker {
  text: string;
  evidenceIds: string[];
}

export interface ScrumReport {
  requestedDate: string;
  requestedLabel: string;
  requestedTasks: TaskActivityItem[];
  todayDate: string;
  todayTasks: TaskActivityItem[];
  blockers: ScrumBlocker[];
}
