export interface TaskActivityItem {
  id: string;
  title: string;
  lastActiveAt: string;
  participantIds: string[];
  evidenceIds: string[];
}

export type TaskActivityStatus = 'refreshing' | 'ready' | 'stale' | 'unavailable';

export interface TaskActivityState {
  tasks: TaskActivityItem[];
  generatedAt: string | null;
  status: TaskActivityStatus;
}

export interface TaskActivitySnapshot {
  version: 1;
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
