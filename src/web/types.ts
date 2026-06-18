import type { SquirlConfig } from '../config.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { Message } from '../types.js';
import type { QueryPipelineStatus } from '../pipeline-status.js';
import type { LocalBackend } from '../api.js';
import type { Participant } from '../agents/types.js';

export interface RuntimeStatus {
  selectedModel: SelectedModel;
  modelDisplay: string;
  workingDir: string;
  tokenCount: number;
  contextWindow: number;
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
  commands: Array<{ name: string; description: string }>;
  participants: Participant[];
}

export interface ChatRequest {
  message: string;
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
