import type { SquirlConfig } from '../config.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { Message } from '../types.js';
import type { QueryPipelineStatus } from '../pipeline-status.js';
import type { LocalBackend } from '../api.js';
import type { Participant } from '../agents/types.js';
import type { CommandDescriptor, CommandSurface } from '../commands/registry.js';
import type { HealthReport, HealthEntry, HealthState } from './health.js';
export type { ContextSnapshot, ContextSnapshotSection, ContextSnapshotDisc } from '../context/context-snapshot.js';

export type { HealthReport, HealthEntry, HealthState };

export interface RuntimeStatus {
  selectedModel: SelectedModel;
  modelDisplay: string;
  workingDir: string;
  tokenCount: number;
  /** Resolved model context window, or null when it's genuinely unknown (UI shows "?"). */
  contextWindow: number | null;
  /** Per-bucket context token estimate, for the context-budget disc grid. */
  contextBreakdown: { system: number; files: number; messages: number };
  isStreaming: boolean;
  toolStatus: string;
  tokensPerSecond: number;
  indexEnabled: boolean;
  storeName: string;
  embedderName: string;
  pipelineStatus: QueryPipelineStatus | null;
}

export interface ContextFileSummary {
  path: string;
  chars: number;
  tokens: number;
}

export interface AppState {
  config: SquirlConfig;
  messages: Message[];
  status: RuntimeStatus;
  contextFiles: ContextFileSummary[];
  commands: CommandDescriptor[];
  participants: Participant[];
  health: HealthReport;
}

export interface ChatRequest {
  message: string;
  recipientId: string;
}

export type ChatEvent =
  | { type: 'state'; state: AppState }
  | { type: 'message'; message: Message }
  | { type: 'assistant-update'; message: Message }
  | { type: 'token'; token: string; assistantId: string }
  | { type: 'assistant-final'; message: Message }
  | { type: 'status'; status: RuntimeStatus }
  | { type: 'agent-status'; participantId: string; status: string }
  | { type: 'tool-approval'; request: ToolApprovalRequest }
  | { type: 'open-command'; surface: CommandSurface }
  | { type: 'toast'; level: 'info' | 'error'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ToolApprovalRequest {
  id: string;
  command: string;
  toolName: string;
}

export interface ModelDetectionResult {
  backend: LocalBackend;
  models: Array<{ id: string; contextWindow?: number }>;
}

export interface ImportRequest {
  source: 'chatgpt';
  path: string;
  embedder?: 'openai' | 'local';
  store?: 'local-chroma' | 'remote-chroma' | 'null';
  chromaUrl?: string;
}

export interface ImportResult {
  count: number;
  source: string;
}

// ---- Eval dashboard ----
import type { EvalRunRequest } from '../search/eval/run.js';
import type { HistoryEntry } from '../search/eval/history.js';
import type { RunResult, JudgeSummary } from '../search/eval/types.js';

export type { EvalRunRequest, HistoryEntry, RunResult, JudgeSummary };

export type EvalEvent =
  | { type: 'progress'; stage: string; detail?: string }
  | { type: 'result'; result: RunResult }
  | { type: 'error'; message: string }
  | { type: 'done' };
