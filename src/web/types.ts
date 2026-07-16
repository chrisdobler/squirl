import type { SquirlConfig } from '../config.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { Message } from '../types.js';
import type { QueryPipelineStatus } from '../pipeline-status.js';
import type { TurnPipelineTrace } from '../pipeline-trace.js';
import type { LocalBackend } from '../api.js';
import type { AgentInteractionRequest, Participant } from '../agents/types.js';
import type { ParticipantWorkState } from '../agents/turn-scheduler.js';
import type { TaskActivityState } from '../tasks/types.js';
import type { CommandDescriptor, CommandSurface } from '../commands/registry.js';
import type { HealthReport, HealthEntry, HealthState } from './health.js';
import type { SystemInteraction } from '../agents/system-interactions.js';
import type { TurnSemanticProgress } from '../semantic-progress.js';
export type { ContextSnapshot, ContextSnapshotSection, ContextSnapshotDisc } from '../context/context-snapshot.js';
export type { ParticipantContextPreview, ContextPreviewBuckets, ContextPreviewFidelity, ContextPreviewMatrixMode, ContextPreviewSource } from '../agents/context-preview.js';
export type { TaskActivityItem, TaskActivityState, TaskActivityStatus } from '../tasks/types.js';

export type { HealthReport, HealthEntry, HealthState };

export interface RuntimeStatus {
  selectedModel: SelectedModel;
  modelDisplay: string;
  workingDir: string;
  tokenCount: number;
  /** Resolved model context window, or null when it's genuinely unknown (UI shows "?"). */
  contextWindow: number | null;
  /** Whether the displayed usage is the last sent request or a not-yet-sent preview. */
  contextOrigin: 'exact' | 'preview';
  /** Capture time for exact usage; null for a live preview. */
  contextCapturedAt: string | null;
  /** Per-bucket context token estimate, for the context-budget disc grid. */
  contextBreakdown: { system: number; files: number; messages: number };
  isStreaming: boolean;
  toolStatus: string;
  tokensPerSecond: number;
  /** Running-average output sample for the local response currently generating. */
  outputThroughput: { generationId: string; runningTokensPerSecond: number; observedAt: string } | null;
  indexEnabled: boolean;
  storeName: string;
  embedderName: string;
  pipelineStatus: QueryPipelineStatus | null;
  pipelineTrace: TurnPipelineTrace | null;
  /** Newest-first durable Squirl traces retained for transcript inspection. */
  recentPipelineTraces: TurnPipelineTrace[];
  semanticProgress: TurnSemanticProgress | null;
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
  taskActivity: TaskActivityState;
  work: ParticipantWorkState;
  /** Runtime-only pending agent prompts, included so reconnecting clients can rehydrate them. */
  agentInteractions: Array<{ participantId: string; request: AgentInteractionRequest }>;
  /** Durable runtime prompts that are deliberately excluded from the transcript. */
  systemInteractions: SystemInteraction[];
  storage: { available: boolean; error?: string; ambiguousLegacyMessageIds?: string[] };
}

export interface ChatRequest {
  message: string;
  recipientId: string;
  clientId?: string;
  requestId: string;
}

export interface ChatAccepted {
  turnId: string;
  participantId: string;
  started: boolean;
  queuePosition: number;
}

export type ChatEvent =
  | { type: 'state'; state: AppState }
  | { type: 'message'; message: Message }
  | { type: 'assistant-update'; message: Message }
  | { type: 'token'; token: string; assistantId: string }
  | { type: 'assistant-final'; message: Message }
  | { type: 'semantic-progress'; progress: TurnSemanticProgress | null }
  | { type: 'activity-update'; message: Extract<Message, { role: 'activity' }> }
  | { type: 'status'; status: RuntimeStatus }
  | { type: 'agent-status'; participantId: string; status: string }
  | { type: 'task-activity'; taskActivity: TaskActivityState }
  | { type: 'work-state'; work: ParticipantWorkState }
  | { type: 'storage-status'; available: boolean; message?: string }
  | { type: 'tool-approval'; request: ToolApprovalRequest }
  | { type: 'agent-interaction'; participantId: string; request: AgentInteractionRequest }
  | { type: 'system-interactions'; systemInteractions: SystemInteraction[] }
  | { type: 'agent-editor-prefill'; participantId: string; text: string }
  | { type: 'agent-terminal-output'; participantId: string; data: string }
  | { type: 'agent-terminal-exit'; participantId: string; code: number }
  | { type: 'agent-operation'; participantId: string; operation: 'terminal' | 'compact'; state: 'starting' | 'active' | 'queued' | 'running' | 'done' | 'error'; message?: string }
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
