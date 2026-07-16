export type PipelineStageState =
  | 'pending' | 'running' | 'succeeded' | 'skipped'
  | 'declined' | 'timed-out' | 'malformed' | 'failed';
export type PipelineExecutionType = 'llm' | 'runtime' | 'embedder' | 'datastore' | 'search' | 'agent';

export type PipelineStageId =
  | 'request' | 'action-plan' | 'capability' | 'turn-intent' | 'memory-embed' | 'memory-vector'
  | 'research-consent' | 'research-search' | 'research-fetch' | 'context'
  | 'answer' | 'native-tools' | 'confidence' | 'handoff';

export interface PipelineTraceStage {
  id: PipelineStageId;
  label: string;
  executionType: PipelineExecutionType;
  state: PipelineStageState;
  service?: string;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
}

export interface TurnPipelineTrace {
  version: 1;
  turnId: string;
  /** Visible Squirl response produced by this durable turn, when one exists. */
  assistantMessageId?: string;
  request: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  stages: PipelineTraceStage[];
}

export interface PipelineTraceUpdate extends Partial<Omit<PipelineTraceStage, 'id'>> { id: PipelineStageId }

const STAGES: Array<Pick<PipelineTraceStage, 'id' | 'label' | 'executionType'>> = [
  { id: 'request', label: 'Request intake', executionType: 'runtime' },
  { id: 'action-plan', label: 'Request routing', executionType: 'llm' },
  { id: 'capability', label: 'Native capability', executionType: 'runtime' },
  { id: 'turn-intent', label: 'Deterministic turn intent', executionType: 'runtime' },
  { id: 'memory-embed', label: 'Memory embedding', executionType: 'embedder' },
  { id: 'memory-vector', label: 'Vector database', executionType: 'datastore' },
  { id: 'research-consent', label: 'Research consent', executionType: 'runtime' },
  { id: 'research-search', label: 'Web search', executionType: 'search' },
  { id: 'research-fetch', label: 'Page fetch', executionType: 'search' },
  { id: 'context', label: 'Context assembly', executionType: 'runtime' },
  { id: 'answer', label: 'Answer model', executionType: 'llm' },
  { id: 'native-tools', label: 'Native tool loop', executionType: 'runtime' },
  { id: 'confidence', label: 'Confidence assessor', executionType: 'llm' },
  { id: 'handoff', label: 'Specialist verification', executionType: 'agent' },
];

const MAX_STRING = 4_000;
const SECRET_KEY = /(authorization|cookie|secret|password|api[-_]?key|bearer|^token$|(?:access|refresh|id|auth)[-_]?token)/i;

export function safeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated: depth]';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated ${value.length - MAX_STRING} chars]` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeTraceValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 60).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : safeTraceValue(item, depth + 1)]));
  return String(value);
}

export function createTurnPipelineTrace(turnId: string, request: string): TurnPipelineTrace {
  const startedAt = new Date().toISOString();
  return {
    version: 1, turnId, request: String(safeTraceValue(request)), state: 'running', startedAt,
    stages: STAGES.map((stage) => ({ ...stage, state: stage.id === 'request' ? 'succeeded' : 'pending', ...(stage.id === 'request' ? { startedAt, finishedAt: startedAt, durationMs: 0, input: { request: safeTraceValue(request) } } : {}) })),
  };
}

export function updateTurnPipelineTrace(trace: TurnPipelineTrace, update: PipelineTraceUpdate): TurnPipelineTrace {
  const now = new Date().toISOString();
  return {
    ...trace,
    stages: trace.stages.map((stage) => {
      if (stage.id !== update.id) return stage;
      const startedAt = update.state === 'running' && !stage.startedAt ? now : update.startedAt ?? stage.startedAt;
      const finishedAt = update.state && ['succeeded', 'skipped', 'declined', 'timed-out', 'malformed', 'failed'].includes(update.state) ? update.finishedAt ?? now : update.finishedAt ?? stage.finishedAt;
      return {
        ...stage, ...update, ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}),
        ...(startedAt && finishedAt ? { durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime() } : {}),
        ...(update.input !== undefined ? { input: safeTraceValue(update.input) } : {}),
        ...(update.output !== undefined ? { output: safeTraceValue(update.output) } : {}),
      };
    }),
  };
}

export function finishTurnPipelineTrace(trace: TurnPipelineTrace, state: 'succeeded' | 'failed'): TurnPipelineTrace {
  const finishedAt = new Date().toISOString();
  return {
    ...trace,
    state,
    finishedAt,
    stages: trace.stages.map((stage) => {
      if (stage.state !== 'pending' && stage.state !== 'running') return stage;
      const nextState: PipelineStageState = stage.state === 'running' && state === 'failed' ? 'failed' : 'skipped';
      const startedAt = stage.startedAt;
      return {
        ...stage,
        state: nextState,
        detail: stage.detail ?? (state === 'failed' ? 'Turn ended before this stage completed.' : 'Stage was not needed for this turn.'),
        finishedAt,
        ...(startedAt ? { durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime() } : {}),
      };
    }),
  };
}
