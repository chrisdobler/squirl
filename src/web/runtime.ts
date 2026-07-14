import { EventEmitter } from 'node:events';
import { homedir, platform } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

import { Orchestrator } from '../orchestrator.js';
import { getModelConfig, resolveContextWindow } from '../model-config.js';
import { buildSystemPrompt } from '../context/system-prompt.js';
import type { ContextSnapshot } from '../context/context-snapshot.js';
import { estimateTokens } from '../context/token-estimator.js';
import { loadConfig, saveConfig, applyConfigToEnv, rememberContextWindow, type SquirlConfig } from '../config.js';
import { appendMessage, loadHistory, appendImportMessage, getAllHistoryFiles, loadAllHistoryEntries, readEntries, rewindHistoryAfter } from '../history.js';
import { detectLocalBackend, fetchAvailableModels, streamChatCompletion, BACKEND_DISPLAY_NAMES } from '../api.js';
import { buildHealthTargets, probeChat, probeEmbedder, probeVectorStore, unknownReport, type HealthReport, type HealthEntry } from './health.js';
import { getCommands, matchCommand } from '../commands/registry.js';
import { buildRewindCandidates, rewindRequestFromCandidate, type RewindRequest } from '../rewind.js';
import { messagesToTurnPairs } from '../search/turn-pair.js';
import { createEmbedder } from '../search/embedders/index.js';
import { createVectorStore, formatVectorStoreStartupError } from '../search/stores/index.js';
import { IngestQueue } from '../search/ingest-queue.js';
import { StatusEmitter } from '../search/status.js';
import { MemoryPipeline } from '../search/memory-pipeline.js';
import { createConfiguredMetaLLM } from '../search/meta-llm.js';
import type { MetaLLM } from '../search/meta-extract.js';
import { recall } from '../search/recall.js';
import { isVectorStoreError } from '../search/stores/chroma.js';
import { executeEvalRun, evalConfigFromSquirl, answerModelFromSquirl, judgeFromSquirl } from '../search/eval/run.js';
import { readHistory, type HistoryEntry } from '../search/eval/history.js';
import type { EvalRunRequest, EvalEvent } from './types.js';
import { backfillFromHistory } from '../search/backfill.js';
import { GroupChatCoordinator } from '../agents/coordinator.js';
import { LocalSpawnTransport } from '../agents/transport/local-spawn.js';
import { buildAgentDescriptor } from '../agents/factory.js';
import { SQUIRL_PARTICIPANT } from '../agents/participants.js';
import { materializeProfile, nextAvailableAgentId, profileFromDescriptor, removeAgentProfile, upsertAgentProfile, validateAgentHandle } from '../agents/profiles.js';
import { delegationConfirmationResponse, delegationConfirmationText, recoverPendingDelegation, resolveDelegationIntent, type DelegationAgent, type DelegationIntent } from '../agents/delegation.js';
import type { AgentEvent, AgentInteractionRequest, AgentInteractionResponse, AgentKind, ClaudePermissionMode, CodexApprovalPolicy, CodexSandbox, Participant, PiApprovalMode, PiToolMode } from '../agents/types.js';
import { contextPreviewFromSnapshot, inspectParticipantContext, unavailableContextPreview, type ParticipantContextPreview } from '../agents/context-preview.js';
import { loadParticipantContextPreviews, saveParticipantContextPreviews } from '../agents/context-preview-store.js';
import type { AddAgentResult, AgentSummary } from '../commands/registry.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { EffortLevel, Message, AssistantMessage } from '../types.js';
import type { QueryPipelineStatus } from '../pipeline-status.js';
import type { VectorStore } from '../search/types.js';
import type { AppState, ChatEvent, ContextFileSummary, ImportRequest, ImportResult, ModelDetectionResult, RuntimeStatus, ToolApprovalRequest } from './types.js';
import { boundedToolOutput } from '../tool-activity.js';
import { discoverCodexModels, resolveCodexBinary } from '../agents/codex-models.js';
import { resolvePiBinary } from '../agents/pi-models.js';
import { buildRecentTaskEvidence, TASK_ACTIVITY_WINDOW_MS, taskEvidenceWatermark } from '../tasks/evidence.js';
import { classifyCurrentTasks } from '../tasks/classifier.js';
import { loadTaskActivitySnapshot, saveTaskActivitySnapshot } from '../tasks/store.js';
import type { TaskActivitySnapshot, TaskActivityState } from '../tasks/types.js';
import { TASK_CLARIFICATION_CHECK_MS, hasCurrentTask, lastTaskClarificationAt, shouldAskTaskClarification, taskClarificationQuestion, taskUncertaintyStart } from '../tasks/clarification.js';
import { CALENDAR_WRITE_SCOPE, GoogleCalendarClient } from '../calendar/google.js';
import { clearCalendarClientCredentials, clearCalendarCredentials, clearCalendarSnapshot, loadCalendarClientCredentials, loadCalendarSnapshot, loadCalendarTokens, loadTaskCalendarSync, saveCalendarSnapshot, saveCalendarTokens, saveTaskCalendarSync } from '../calendar/store.js';
import type { CalendarSnapshot } from '../calendar/types.js';
import { CALENDAR_LOOKAHEAD_MS, CALENDAR_LOOKBACK_MS, mergeTaskAndCalendarActivity } from '../calendar/merge.js';
import { syncInferredTaskEvents } from '../calendar/task-sync.js';
import { ParticipantTurnScheduler, type EnqueueResult, type ParticipantTurn, type ParticipantWorkState, type TurnExecutionContext } from '../agents/turn-scheduler.js';
import { formatScrumReport, generateScrumReport } from '../tasks/scrum.js';

interface PendingApproval {
  request: ToolApprovalRequest;
  resolve: (approved: boolean) => void;
}

export interface UpdateAgentOptions {
  name?: string;
  model?: string | null;
  effort?: EffortLevel | null;
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  piToolMode?: PiToolMode;
  piApprovalMode?: PiApprovalMode;
}

const CODEX_SANDBOXES = new Set<CodexSandbox>(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(['on-request', 'untrusted', 'never']);
const PI_APPROVAL_MODES = new Set<PiApprovalMode>(['manual', 'acceptEdits', 'never']);
const CLAUDE_PERMISSION_MODES = new Set<ClaudePermissionMode>(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);

function defaultModelFromConfig(config?: SquirlConfig): SelectedModel {
  const provider = config?.defaultProvider ?? 'anthropic';
  if (provider === 'openai') {
    return { id: config?.defaultModel ?? 'gpt-4o', label: config?.defaultModel ?? 'gpt-4o', provider: 'openai' };
  }
  if (provider === 'local') {
    const modelId = config?.defaultModel || 'default';
    return {
      id: modelId,
      label: modelId,
      provider: 'local',
      baseUrl: config?.localBaseUrl ?? 'http://localhost:8000/v1',
      backend: config?.localBackend,
      contextWindow: config?.modelContextWindows?.[modelId],
    };
  }
  return { id: config?.defaultModel ?? 'claude-sonnet-4-6', label: config?.defaultModel ?? 'Claude Sonnet 4.6', provider: 'anthropic' };
}

function resolveUserPath(path: string): string {
  return path.trim().replace(/\\ /g, ' ').replace(/^~/, process.env.HOME ?? '');
}

/** Authed model-list GET for hosted providers (no tokens spent). Throws on missing key / non-OK. */
async function fetchModelIds(url: string, headers: Record<string, string>, key?: string): Promise<string[]> {
  if (!key) throw new Error('no API key configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  } finally {
    clearTimeout(timeout);
  }
}

function listGitFiles(cwd: string): string[] {
  try {
    return execSync('git ls-files', { cwd, encoding: 'utf-8', timeout: 5000 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listFilesFallback(cwd: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, level: number) => {
    if (level > depth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const nextRel = rel ? join(rel, entry.name) : entry.name;
      const nextAbs = join(dir, entry.name);
      out.push(entry.isDirectory() ? `${nextRel}/` : nextRel);
      if (entry.isDirectory()) walk(nextAbs, nextRel, level + 1);
    }
  };
  try {
    walk(cwd, '', 1);
  } catch {
    return [];
  }
  return out;
}

function historySignature(): string {
  const historyDir = join(homedir(), '.squirl', 'history');
  if (!existsSync(historyDir)) return 'missing';

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(path);
      }
    }
  };

  try {
    walk(historyDir);
  } catch {
    return 'unreadable';
  }

  return files.sort().map((file) => {
    try {
      const stat = statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${file}:missing`;
    }
  }).join('|');
}

export class SquirlRuntime extends EventEmitter {
  private config: SquirlConfig;
  private messages: Message[];
  private selectedModel: SelectedModel;
  private orchestrator: Orchestrator;
  private statusEmitter = new StatusEmitter();
  private ingestQueue: IngestQueue | null = null;
  private embedder: ReturnType<typeof createEmbedder> | null = null;
  private vectorStore: VectorStore | null = null;
  private workingDir: string;
  private isStreaming = false;
  private toolStatus = '';
  private pipelineStatus: QueryPipelineStatus | null = null;
  private tokensPerSecond = 0;
  private streamStart = 0;
  private streamTokens = 0;
  private embedderDisplay = '';
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingTools = new Map<string, { messageId: string; input: unknown }>();
  private agentInteractions: Array<{ participantId: string; request: AgentInteractionRequest }> = [];
  private historySignature = '';
  private configSignature = '';
  private coordinator: GroupChatCoordinator;
  private participantContextPreviews: Record<string, ParticipantContextPreview>;
  private readonly lastAgentErrors = new Map<string, string>();
  private readonly eventSubscribers = new Map<(event: ChatEvent) => void, string | undefined>();
  /** Legacy direct-test sink; production delivery uses eventSubscribers. */
  private activeEmit: ((event: ChatEvent) => void) | null = null;
  private readonly turnScheduler: ParticipantTurnScheduler;
  private workState: ParticipantWorkState = { active: [], queued: [] };
  private evalMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private evalMonitorRunning = false;
  private healthReport: HealthReport;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthChecking = false;
  private taskMetaLLM: MetaLLM | null = null;
  private routingMetaLLM: MetaLLM;
  private taskActivitySnapshot: TaskActivitySnapshot | null;
  private taskRefreshRunning = false;
  private taskRefreshQueued = false;
  private taskRefreshScheduled = false;
  private taskRefreshFailed = true;
  private taskSourceDirty = true;
  /** Legacy direct-test sink; production delivery uses publish(). */
  private taskActivityEmit: ((event: ChatEvent) => void) | null = null;
  private taskUnknownSince: number | null = null;
  private taskClarificationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly calendarClient: GoogleCalendarClient;
  private calendarSnapshot: CalendarSnapshot | null;
  private calendarRefreshRunning = false;
  private calendarRefreshQueued = false;
  private calendarRefreshFailed = false;
  private calendarTimer: ReturnType<typeof setInterval> | null = null;

  constructor(workingDir = process.cwd()) {
    super();
    this.workingDir = workingDir;
    this.config = loadConfig();
    applyConfigToEnv(this.config);
    this.routingMetaLLM = createConfiguredMetaLLM(this.config);
    this.messages = loadHistory();
    this.selectedModel = defaultModelFromConfig(this.config);
    this.healthReport = unknownReport(this.config, this.selectedModel);
    this.taskActivitySnapshot = loadTaskActivitySnapshot();
    this.calendarSnapshot = loadCalendarSnapshot();
    this.calendarClient = new GoogleCalendarClient(
      () => this.config.calendar?.googleClientId ?? process.env.SQUIRL_GOOGLE_CLIENT_ID,
      () => loadCalendarClientCredentials()?.clientSecret ?? process.env.SQUIRL_GOOGLE_CLIENT_SECRET,
      () => loadCalendarTokens(),
      (tokens) => saveCalendarTokens(tokens),
    );
    this.orchestrator = new Orchestrator(workingDir);
    this.participantContextPreviews = loadParticipantContextPreviews(workingDir);
    this.coordinator = new GroupChatCoordinator({
      config: { autoHandoff: this.config.agents?.autoHandoff, maxHops: this.config.agents?.maxHops },
      transport: new LocalSpawnTransport(),
      localTurn: (input, emit, signal) => this.runLocalTurn(input, emit, signal),
      facilitateTurn: (participantId, output, signal) => typeof this.orchestrator.assessFacilitation === 'function'
        ? this.orchestrator.assessFacilitation(participantId, output, this.messages, this.selectedModel, signal)
        : Promise.resolve(null),
    });
    this.coordinator.onEvent((event) => this.handleAgentEvent(event));
    this.turnScheduler = new ParticipantTurnScheduler(
      (turn, context) => this.executeScheduledTurn(turn, context),
      (participantId) => {
        if (participantId === SQUIRL_PARTICIPANT.id) return true;
        return Boolean(this.coordinator.getDescriptor(participantId));
      },
      (error, turn) => this.publish({
        type: 'toast', level: 'error',
        message: `@${turn.participantId} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    this.turnScheduler.onChange((work) => {
      this.workState = work;
      this.publish({ type: 'work-state', work });
    });
    this.syncIdentityContext();
    void this.initializeIndex().then(() => {
      void this.refreshHealth();
      this.scheduleTaskActivityRefresh();
    });
    void this.hydrateSelectedLocalModel();
    void this.startDefaultAgents();
    this.startEvalMonitor();
    this.startHealthChecks();
    this.startCalendarRefresh();
    this.startTaskClarificationChecks();
  }

  getState(): AppState {
    this.refreshSharedState();
    return {
      config: this.config,
      messages: this.messages,
      status: this.getStatus(),
      contextFiles: this.getContextFiles(),
      commands: getCommands().map(({ name, description, usage, aliases, surface, argumentTemplate }) => ({
        name, description, usage, aliases, surface, argumentTemplate,
      })),
      participants: this.coordinator.listParticipants(),
      health: this.healthReport,
      taskActivity: this.getTaskActivityState(),
      work: this.workState,
      agentInteractions: this.agentInteractions,
    };
  }

  subscribeEvents(listener: (event: ChatEvent) => void, clientId?: string): () => void {
    this.eventSubscribers.set(listener, clientId);
    listener({ type: 'state', state: this.getState() });
    return () => this.eventSubscribers.delete(listener);
  }

  private publish(event: ChatEvent, targetClientId?: string): void {
    this.activeEmit?.(event);
    for (const [listener, clientId] of this.eventSubscribers) {
      if (!targetClientId || clientId === targetClientId) listener(event);
    }
  }

  getTaskActivityState(now = Date.now()): TaskActivityState {
    const snapshot = this.taskActivitySnapshot;
    const tokens = loadCalendarTokens();
    const clientConfigured = Boolean(this.config.calendar?.googleClientId?.trim() || process.env.SQUIRL_GOOGLE_CLIENT_ID?.trim());
    const calendarConfigured = this.config.calendar?.enabled === true && clientConfigured;
    const min = now - CALENDAR_LOOKBACK_MS; const max = now + CALENDAR_LOOKAHEAD_MS;
    const calendarEvents = (calendarConfigured && tokens ? this.calendarSnapshot?.events ?? [] : []).filter((event) => Date.parse(event.endAt) >= min && Date.parse(event.startAt) <= max);
    const calendar = {
      status: (!calendarConfigured ? 'disconnected' : !tokens ? 'authorization-required' : this.calendarRefreshRunning ? 'refreshing' : this.calendarRefreshFailed ? 'stale' : 'ready') as TaskActivityState['calendar']['status'],
      connected: Boolean(tokens),
      canWrite: Boolean(tokens?.scopes?.includes(CALENDAR_WRITE_SCOPE)),
      clientConfigured,
      selectionRequired: Boolean(tokens) && this.config.calendar?.selectedCalendarIds == null,
      profile: tokens?.profile ?? null,
      calendars: this.calendarSnapshot?.calendars ?? [],
      refreshedAt: this.calendarSnapshot?.refreshedAt ?? null,
    };
    if (!snapshot) {
      return { tasks: mergeTaskAndCalendarActivity([], calendarEvents, now), generatedAt: null, status: this.taskRefreshRunning ? 'refreshing' : 'unavailable', calendar };
    }
    const cutoff = now - TASK_ACTIVITY_WINDOW_MS;
    if (this.taskRefreshFailed || this.taskSourceDirty) {
      return { tasks: mergeTaskAndCalendarActivity(snapshot.tasks, calendarEvents, now), generatedAt: snapshot.generatedAt, status: this.taskRefreshRunning ? 'refreshing' : 'stale', calendar };
    }
    const inferred = snapshot.tasks.filter((task) => Date.parse(task.lastActiveAt) >= cutoff);
    const tasks = mergeTaskAndCalendarActivity(inferred, calendarEvents, now);
    return {
      tasks,
      generatedAt: snapshot.generatedAt,
      status: this.taskRefreshRunning ? 'refreshing' : 'ready',
      calendar,
    };
  }

  getStatus(): RuntimeStatus {
    const contextWindow = resolveContextWindow(this.selectedModel, this.config) ?? null;
    const contextBreakdown = this.contextBreakdown();
    // +4 per message of role/metadata overhead (matches the TUI status bar).
    const tokenCount = contextBreakdown.system + contextBreakdown.files + contextBreakdown.messages + this.messages.length * 4;
    return {
      selectedModel: this.selectedModel,
      modelDisplay: this.modelDisplay(),
      workingDir: this.workingDir,
      tokenCount,
      contextWindow,
      contextBreakdown,
      isStreaming: this.workState.active.length > 0,
      toolStatus: this.toolStatus,
      tokensPerSecond: this.tokensPerSecond,
      indexEnabled: this.config.index?.enabled ?? false,
      storeName: this.config.index?.store
        ? `${this.config.index.store}${this.config.index.chromaUrl ? ` (${this.config.index.chromaUrl.replace(/^https?:\/\//, '')})` : ''}`
        : '',
      embedderName: this.embedderDisplay,
      pipelineStatus: this.pipelineStatus,
    };
  }

  systemPrompt(): string {
    const assembled = typeof this.orchestrator.getLastPromptStack === 'function' ? this.orchestrator.getLastPromptStack() : '';
    if (assembled) return assembled;
    const config = getModelConfig(this.selectedModel.id);
    const message = buildSystemPrompt({
      workingDir: this.workingDir, date: new Date().toISOString().slice(0, 10),
      modelId: this.selectedModel.id, platform: platform(), shell: process.env.SHELL ?? 'unknown',
      supportsTools: config.supportsTools, displayName: this.config.userProfile?.displayName,
      participants: this.coordinator.listParticipants().map(({ id, label, status, specialty }) => ({ id, label, status, specialty })),
    }, config.systemPromptStyle);
    return `=== BASE INSTRUCTIONS ===\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2)}`;
  }

  async updateConfig(next: SquirlConfig): Promise<AppState> {
    if (this.config.calendar?.googleClientId !== next.calendar?.googleClientId) {
      clearCalendarCredentials();
      clearCalendarClientCredentials();
    }
    this.config = next;
    applyConfigToEnv(next);
    this.routingMetaLLM = createConfiguredMetaLLM(next);
    saveConfig(next);
    this.syncIdentityContext();
    this.selectedModel = defaultModelFromConfig(next);
    await this.initializeIndex();
    await this.hydrateSelectedLocalModel();
    this.startEvalMonitor(); // pick up monitor config changes
    this.startCalendarRefresh();
    this.healthReport = unknownReport(this.config, this.selectedModel); // targets may have changed
    void this.refreshHealth();
    this.markTaskActivityChanged();
    this.configSignature = '';
    return this.getState();
  }

  calendarAuthorizationUrl(callbackOrigin: string, returnOrigin?: string): string {
    return this.calendarClient.authorizationUrl(callbackOrigin, returnOrigin);
  }

  async completeCalendarAuthorization(code: string, state: string): Promise<string> {
    const returnUri = await this.calendarClient.completeAuthorization(code, state);
    if (!this.config.calendar?.enabled) {
      this.config = { ...this.config, calendar: { ...this.config.calendar, enabled: true, refreshMinutes: 5 } };
      saveConfig(this.config);
    }
    await this.refreshCalendar();
    this.startCalendarRefresh();
    return returnUri;
  }

  async updateCalendarSelection(ids: string[]): Promise<AppState> {
    const known = new Set(this.calendarSnapshot?.calendars.map((calendar) => calendar.id) ?? []);
    const selectedCalendarIds = [...new Set(ids.filter((id) => known.has(id)))];
    this.config = { ...this.config, calendar: { ...this.config.calendar, enabled: true, selectedCalendarIds, refreshMinutes: this.config.calendar?.refreshMinutes ?? 5 } };
    saveConfig(this.config);
    await this.refreshCalendar();
    return this.getState();
  }

  async disconnectCalendar(): Promise<AppState> {
    clearCalendarCredentials();
    clearCalendarSnapshot();
    this.calendarSnapshot = null;
    this.calendarRefreshFailed = false;
    this.config = { ...this.config, calendar: { ...this.config.calendar, enabled: false, selectedCalendarIds: [] } };
    saveConfig(this.config);
    this.startCalendarRefresh();
    this.emitTaskActivity();
    return this.getState();
  }

  async refreshCalendar(): Promise<void> {
    this.calendarRefreshQueued = true;
    if (this.calendarRefreshRunning) return;
    this.calendarRefreshRunning = true;
    this.emitTaskActivity();
    try {
      while (this.calendarRefreshQueued) {
        this.calendarRefreshQueued = false;
        if (!this.config.calendar?.enabled || !loadCalendarTokens()) return;
        await this.calendarClient.ensureProfile();
        const configured = this.config.calendar.selectedCalendarIds ?? [];
        const calendars = await this.calendarClient.listCalendars(configured);
        const writeCalendarId = this.config.calendar.taskWriteCalendarId
          ?? calendars.find((calendar) => calendar.primary)?.id
          ?? calendars.find((calendar) => calendar.selected)?.id;
        if (this.config.calendar.syncInferredTasks && loadCalendarTokens()?.scopes?.includes(CALENDAR_WRITE_SCOPE) && this.taskActivitySnapshot && writeCalendarId) {
          await syncInferredTaskEvents({
            snapshot: this.taskActivitySnapshot,
            state: loadTaskCalendarSync(),
            calendarId: writeCalendarId,
            client: this.calendarClient,
            save: saveTaskCalendarSync,
            activeHorizonMs: (Math.max(1, this.config.calendar.refreshMinutes ?? 5) * 60_000) + 30_000,
          });
        }
        const selected = new Set(calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id));
        if (this.config.calendar.syncInferredTasks && writeCalendarId) selected.add(writeCalendarId);
        const now = Date.now();
        const events = await this.calendarClient.listEvents([...selected], new Date(now - CALENDAR_LOOKBACK_MS).toISOString(), new Date(now + CALENDAR_LOOKAHEAD_MS).toISOString());
        const snapshot: CalendarSnapshot = { version: 1, refreshedAt: new Date().toISOString(), calendars, events };
        saveCalendarSnapshot(snapshot);
        const changed = JSON.stringify(this.calendarSnapshot?.events ?? []) !== JSON.stringify(events);
        this.calendarSnapshot = snapshot;
        this.calendarRefreshFailed = false;
        if (changed) this.markTaskActivityChanged();
      }
    } catch {
      this.calendarRefreshFailed = true;
    } finally {
      this.calendarRefreshRunning = false;
      this.emitTaskActivity();
      if (this.calendarRefreshQueued) void this.refreshCalendar();
    }
  }

  private startCalendarRefresh(): void {
    if (this.calendarTimer) clearInterval(this.calendarTimer);
    this.calendarTimer = null;
    if (!this.config.calendar?.enabled || !loadCalendarTokens()) return;
    void this.refreshCalendar();
    const minutes = Math.max(1, this.config.calendar.refreshMinutes ?? 5);
    this.calendarTimer = setInterval(() => void this.refreshCalendar(), minutes * 60_000);
    this.calendarTimer.unref?.();
  }

  async selectModel(model: SelectedModel): Promise<AppState> {
    this.selectedModel = model;
    await this.hydrateSelectedLocalModel();
    this.persistContextWindow();
    return this.getState();
  }

  async detectModels(baseUrl: string): Promise<ModelDetectionResult> {
    const backend = await detectLocalBackend(baseUrl);
    const models = await fetchAvailableModels(baseUrl, backend);
    return { backend, models };
  }

  async testModelConnection(model: SelectedModel = this.selectedModel): Promise<{ ok: boolean; content: string }> {
    await this.hydrateSelectedLocalModel();
    let content = '';
    let error: Error | null = null;
    await streamChatCompletion({
      messages: [{ role: 'user', content: 'Say OK.' }],
      model,
      onToken: (token) => { content += token; },
      onDone: () => {},
      onError: (err) => { error = err; },
    });
    if (error) throw error;
    return { ok: true, content };
  }

  listWorkspaceFiles(query = ''): string[] {
    const files = listGitFiles(this.workingDir);
    const candidates = files.length > 0 ? files : listFilesFallback(this.workingDir);
    const q = query.trim().toLowerCase();
    return candidates
      .filter((path) => !q || path.toLowerCase().includes(q))
      .slice(0, 200);
  }

  listDirectories(path = this.workingDir): { path: string; parent: string | null; directories: Array<{ name: string; path: string }> } {
    const target = resolve(this.workingDir, resolveUserPath(path));
    if (!existsSync(target)) throw new Error(`Directory does not exist: ${target}`);
    if (!statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
    const directories = readdirSync(target, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name.startsWith('.')) return false;
        try { return entry.isDirectory() || statSync(join(target, entry.name)).isDirectory(); }
        catch { return false; }
      })
      .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(target);
    return { path: target, parent: parent === target ? null : parent, directories };
  }

  getContextFiles(): ContextFileSummary[] {
    return Array.from(this.orchestrator.getContextFiles().entries()).map(([path, content]) => ({
      path,
      chars: content.length,
      tokens: estimateTokens(content),
    }));
  }

  getContextSnapshot(): ContextSnapshot | null {
    return this.orchestrator.getContextSnapshot(this.messages, this.selectedModel);
  }

  getParticipantContextPreview(participantId: string): ParticipantContextPreview | null {
    const participant = this.coordinator.listParticipants().find((candidate) => candidate.id === participantId && candidate.kind !== 'user');
    if (!participant) return null;
    if (participant.kind === 'local-llm') {
      return contextPreviewFromSnapshot(participant.id, this.orchestrator.getContextSnapshot(this.messages, this.selectedModel));
    }
    if (participant.kind !== 'claude-code' && participant.kind !== 'codex' && participant.kind !== 'pi') return null;
    const persisted = this.participantContextPreviews[participant.id];
    if (persisted) return persisted;
    const telemetry = this.coordinator.getContextTelemetry(participant.id) ?? { participantId: participant.id };
    return unavailableContextPreview(
      participant.id,
      participant.kind === 'claude-code' ? 'claude-session' : participant.kind === 'codex' ? 'codex-session' : 'pi-session',
      'No completed turn input has been captured for this agent yet.',
      telemetry.modelId,
    );
  }

  addContextFile(path: string): AppState {
    this.orchestrator.addContextFile(path);
    return this.getState();
  }

  removeContextFile(path: string): AppState {
    this.orchestrator.removeContextFile(path);
    return this.getState();
  }

  clearContextFiles(): AppState {
    this.orchestrator.clearContextFiles();
    return this.getState();
  }

  approveToolRequest(id: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    this.pendingApprovals.delete(id);
    pending.resolve(approved);
    return true;
  }

  async respondToAgentInteraction(participantId: string, id: string, response: AgentInteractionResponse): Promise<void> {
    const exists = this.agentInteractions.some((item) => item.participantId === participantId && item.request.id === id);
    if (!exists) return;
    await this.coordinator.respondToInteraction(participantId, id, response);
    this.agentInteractions = this.agentInteractions.filter((item) => item.participantId !== participantId || item.request.id !== id);
  }

  cancel(participantId = SQUIRL_PARTICIPANT.id): boolean {
    const cancelled = this.turnScheduler.cancel(participantId);
    if (cancelled && participantId !== SQUIRL_PARTICIPANT.id) void this.coordinator.interrupt(participantId);
    return cancelled;
  }

  async importHistory(request: ImportRequest): Promise<ImportResult> {
    if (request.source !== 'chatgpt') {
      throw new Error(`Unsupported import source: ${request.source}`);
    }
    const { ChatGPTImporter } = await import('../search/importers/chatgpt.js');
    const importer = new ChatGPTImporter();
    const path = resolveUserPath(request.path);
    let count = 0;
    for await (const pair of importer.parse(path)) {
      if (pair.userText) appendImportMessage({ id: crypto.randomUUID(), role: 'user', content: pair.userText }, 'chatgpt', pair.timestamp);
      if (pair.assistantText) appendImportMessage({ id: crypto.randomUUID(), role: 'assistant', content: pair.assistantText }, 'chatgpt', pair.timestamp);
      count++;
    }
    this.messages = loadHistory();
    this.historySignature = historySignature();

    if (request.store || request.embedder || request.chromaUrl) {
      const embedder = createEmbedder({ type: request.embedder ?? 'openai', apiKey: this.config.openaiApiKey });
      const store = await createVectorStore({ type: request.store ?? 'local-chroma', chromaUrl: request.chromaUrl ?? 'http://localhost:8000' });
      const status = new StatusEmitter();
      const queue = new IngestQueue(embedder, store, status);
      for await (const pair of importer.parse(path)) {
        queue.enqueue(pair);
      }
      await queue.flush();
      await store.close();
    }

    return { count, source: request.source };
  }

  async rewind(request: RewindRequest): Promise<AppState> {
    if (this.isStreaming) throw new Error('Cannot rewind while streaming.');
    this.refreshSharedState();

    const visibleRetained = this.messages.slice(0, request.retainedCount);
    const visibleRemoved = this.messages.slice(request.retainedCount);
    const writableIds = new Set(
      getAllHistoryFiles().flatMap((file) => readEntries(file).map((entry) => entry.message.id)),
    );
    const persistedIds = new Set(loadHistory().map((message) => message.id));

    if (request.targetMessageId !== null && !writableIds.has(request.targetMessageId)) {
      throw new Error('Cannot rewind to imported history; choose a Squirl message.');
    }
    const nonWritableRemoved = visibleRemoved.filter((message) => !writableIds.has(message.id) && persistedIds.has(message.id));
    if (nonWritableRemoved.length > 0) {
      throw new Error('Cannot rewind across imported history; imported archives are preserved.');
    }

    const oldPairIds = new Set(messagesToTurnPairs(this.messages, 'current', 'squirl').map((pair) => pair.id));
    const retainedPairIds = new Set(messagesToTurnPairs(visibleRetained, 'current', 'squirl').map((pair) => pair.id));
    const deleteIds = [...oldPairIds].filter((id) => !retainedPairIds.has(id));
    const result = rewindHistoryAfter(request.targetMessageId);
    if (!result.targetFound) throw new Error('Cannot rewind: target message is not in writable Squirl history.');

    this.messages = visibleRetained;
    this.historySignature = historySignature();
    this.markTaskActivityChanged();
    if (deleteIds.length > 0 && this.vectorStore) {
      await this.vectorStore.delete(deleteIds);
    }
    this.emit('toast', { level: 'info', message: `Rewound ${visibleRemoved.length} message${visibleRemoved.length === 1 ? '' : 's'}.` });
    return this.getState();
  }

  rewindCandidates(): Array<RewindRequest & { messageId: string; messageIndex: number; preview: string }> {
    this.refreshSharedState();
    return buildRewindCandidates(this.messages).map((candidate) => ({
      ...rewindRequestFromCandidate(candidate),
      messageId: candidate.message.id,
      messageIndex: candidate.messageIndex,
      preview: candidate.message.content.slice(0, 140),
    }));
  }

  submitChat(input: string, recipientId: string, clientId?: string): EnqueueResult {
    const value = input.trim();
    if (!value) throw new Error('Message is empty.');
    if (recipientId !== SQUIRL_PARTICIPANT.id && !this.coordinator.hasAgent(recipientId)) {
      throw new Error(`No such agent: ${recipientId}`);
    }
    return this.turnScheduler.enqueue(recipientId, value, clientId ? { clientId } : undefined);
  }

  /** Compatibility path for direct runtime callers; web clients use submitChat + /api/events. */
  async chat(input: string, recipientId: string, emit: (event: ChatEvent) => void): Promise<void> {
    this.eventSubscribers.set(emit, undefined);
    try {
      const result = this.submitChat(input, recipientId);
      await this.turnScheduler.waitForTurn(result.turn.id);
    } finally {
      this.eventSubscribers.delete(emit);
    }
  }

  removeQueuedTurn(turnId: string): boolean {
    return this.turnScheduler.removeQueued(turnId);
  }

  private async executeScheduledTurn(turn: ParticipantTurn, context: TurnExecutionContext): Promise<void> {
    const emit = (event: ChatEvent) => this.publish(event);
    context.setPhase('preparing');
    const clientId = (turn.metadata as { clientId?: string } | undefined)?.clientId;
    await this.executeChat(turn.input, turn.participantId, emit, context, clientId);
  }

  private async executeChat(input: string, recipientId: string, emit: (event: ChatEvent) => void, turnContext: TurnExecutionContext, clientId?: string): Promise<void> {
    const value = input.trim();
    if (!value) return;

    const command = matchCommand(value);
    if (command) {
      this.refreshSharedState();
      await command.execute({
        orchestrator: this.orchestrator,
        messages: this.messages,
        workingDir: this.workingDir,
        modelId: this.selectedModel.id,
        setMessages: (fn) => { this.messages = fn(this.messages); },
        openContextPicker: () => this.publish({ type: 'toast', level: 'info', message: 'Open the Context panel to manage files.' }, clientId),
        openSetup: () => this.publish({ type: 'toast', level: 'info', message: 'Open Settings to change provider, keys, or index settings.' }, clientId),
        embedder: this.embedder ?? undefined,
        vectorStore: this.vectorStore ?? undefined,
        indexEnabled: this.config.index?.enabled ?? false,
        recallQuery: value.startsWith('/recall ') ? value.slice(8).trim() : '',
        commandInput: value,
        requestRewind: (request) => { void this.rewind(request).then((state) => emit({ type: 'state', state })).catch((err) => emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })); },
        openRewindPicker: () => emit({ type: 'toast', level: 'info', message: 'Open the Rewind panel to choose a visual target.' }),
        openCommandSurface: (surface) => this.publish({ type: 'open-command', surface }, clientId),
        addAgent: (kind, opts) => this.addAgent(kind, opts),
        stopAgent: (id) => this.stopAgent(id),
        renameAgent: (id, name) => this.renameAgent(id, name),
        listAgents: () => this.listAgents(),
        generateScrum: (dateInput) => this.generateScrum(dateInput),
      });
      emit({ type: 'state', state: this.getState() });
      return;
    }

    await this.refreshSharedStateAsync();
    const delegationAgents = new Map<string, DelegationAgent>();
    for (const profile of this.config.agents?.defaults ?? []) {
      if (!profile.id) continue;
      delegationAgents.set(profile.id, { id: profile.id, label: profile.label, kind: profile.kind, connected: this.coordinator.hasAgent(profile.id) });
    }
    for (const participant of this.coordinator.listParticipants()) {
      if (participant.kind !== 'claude-code' && participant.kind !== 'codex' && participant.kind !== 'pi') continue;
      delegationAgents.set(participant.id, { id: participant.id, label: participant.label, kind: participant.kind, connected: this.coordinator.hasAgent(participant.id) });
    }
    const knownDelegationAgents = [...delegationAgents.values()];
    let delegation: DelegationIntent | null = null;
    if (recipientId === SQUIRL_PARTICIPANT.id) {
      const pending = recoverPendingDelegation(this.messages);
      const response = pending ? delegationConfirmationResponse(value) : 'unrelated';
      if (pending && response === 'confirm') {
        const targets = pending.targetIds.map((id) => knownDelegationAgents.find((agent) => agent.id === id)!).filter(Boolean);
        delegation = {
          targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
          unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
          originalRequest: pending.originalRequest,
          task: pending.task,
          trigger: 'natural-language',
        };
      } else if (pending && response === 'cancel') {
        const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value, participantId: SQUIRL_PARTICIPANT.id };
        const assistant: AssistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: 'Okay, I won’t dispatch that work.', createdAt: new Date().toISOString() };
        this.messages = [...this.messages, userMsg, assistant];
        appendMessage(userMsg);
        appendMessage(assistant);
        this.historySignature = historySignature();
        this.markTaskActivityChanged(emit);
        emit({ type: 'message', message: userMsg });
        emit({ type: 'assistant-final', message: assistant });
        return;
      } else {
        const resolution = await resolveDelegationIntent(value, knownDelegationAgents, this.routingMetaLLM);
        if (resolution.kind === 'dispatch') delegation = resolution.delegation;
        if (resolution.kind === 'confirm') {
          const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value, participantId: SQUIRL_PARTICIPANT.id };
          const assistant: AssistantMessage = {
            id: crypto.randomUUID(), role: 'assistant', content: delegationConfirmationText(resolution.pending),
            proactiveKind: 'delegation-confirmation', delegationConfirmation: resolution.pending,
            createdAt: new Date().toISOString(),
          };
          this.messages = [...this.messages, userMsg, assistant];
          appendMessage(userMsg);
          appendMessage(assistant);
          this.historySignature = historySignature();
          this.markTaskActivityChanged(emit);
          emit({ type: 'message', message: userMsg });
          emit({ type: 'assistant-final', message: assistant });
          return;
        }
      }
    }
    this.isStreaming = recipientId === SQUIRL_PARTICIPANT.id;
    this.tokensPerSecond = 0;
    this.streamStart = Date.now();
    this.streamTokens = 0;
    turnContext.setPhase('preparing');
    emit({ type: 'status', status: this.getStatus() });

    try {
      if (delegation) {
        const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value, participantId: SQUIRL_PARTICIPANT.id };
        this.messages = [...this.messages, userMsg];
        appendMessage(userMsg);
        this.historySignature = historySignature();
        this.markTaskActivityChanged(emit);
        this.emitTaskActivity();
        emit({ type: 'message', message: userMsg });
        for (const id of delegation.unavailableTargetIds) {
          emit({ type: 'toast', level: 'error', message: `Agent @${id} is not connected. Open Agents and connect it before delegating work.` });
        }
        try {
          await Promise.all(delegation.targetIds.map(async (targetId) => {
            if (turnContext.signal.aborted) return;
            const participant = this.coordinator.listParticipants().find((item) => item.id === targetId);
            if (!participant) return;
            const handoff = await this.orchestrator.prepareHandoff(
              { id: participant.id, label: participant.label, specialty: participant.specialty },
              delegation.originalRequest,
              delegation.task,
              this.messages,
              this.selectedModel,
              turnContext.signal,
              (stage) => {
                this.pipelineStatus = { stage };
                turnContext.setPhase('preparing', stage);
                emit({ type: 'status', status: this.getStatus() });
              },
            );
            const messageId = crypto.randomUUID();
            this.handleAgentEvent({ type: 'message-start', participantId: SQUIRL_PARTICIPANT.id, messageId, responseMeta: { model: this.selectedModel.id } });
            this.handleAgentEvent({ type: 'token', participantId: SQUIRL_PARTICIPANT.id, messageId, token: handoff });
            this.handleAgentEvent({ type: 'message-end', participantId: SQUIRL_PARTICIPANT.id, messageId, content: handoff });
            this.turnScheduler.enqueue(targetId, handoff, { delegated: true, originalRequest: delegation.originalRequest });
          }));
        } catch (error) {
          emit({ type: 'toast', level: 'error', message: `Could not prepare delegation: ${error instanceof Error ? error.message : String(error)}` });
        }
        return;
      }

      if (recipientId !== SQUIRL_PARTICIPANT.id) {
        if (!this.coordinator.hasAgent(recipientId)) throw new Error(`No such agent: ${recipientId}`);
        const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value, participantId: recipientId };
        this.messages = [...this.messages, userMsg];
        appendMessage(userMsg);
        this.historySignature = historySignature();
        this.markTaskActivityChanged(emit);
        this.emitTaskActivity();
        emit({ type: 'message', message: userMsg });
        this.lastAgentErrors.delete(recipientId);
        turnContext.setPhase('working');
        await this.coordinator.dispatchTo(recipientId, value, turnContext.signal);
        return;
      }

      const priorMessages = this.messages.filter((message) =>
        !(message.role === 'assistant' && message.isStreaming)
        && !(message.role === 'tool' && message.toolStatus === 'running'));
      let localAssistantId = '';
      const newMessages = await this.orchestrator.chat(
        value,
        priorMessages,
        this.selectedModel,
        {
          onNewMessage: (message) => {
            if (message.role === 'user') message = { ...message, participantId: SQUIRL_PARTICIPANT.id };
            if (message.role === 'assistant') {
              message = { ...message, responseMeta: { model: this.selectedModel.id } };
              localAssistantId = message.id;
            }
            this.messages = [...this.messages, message];
            if (message.role !== 'assistant') {
              appendMessage(message);
              this.historySignature = historySignature();
              if (message.role === 'user') this.markTaskActivityChanged(emit);
            }
            emit({ type: 'message', message });
          },
          onToken: (token, assistant) => {
            if (token) this.streamTokens++;
            const elapsed = (Date.now() - this.streamStart) / 1000;
            if (elapsed > 0.5) this.tokensPerSecond = Math.round(this.streamTokens / elapsed);
            const current = this.messages.find((message) => message.id === assistant.id);
            if (current?.role === 'assistant' && current.isStreaming) {
              const updated = { ...assistant, responseMeta: current.responseMeta };
              this.messages = this.messages.map((message) => message.id === assistant.id ? updated : message);
              emit({ type: 'assistant-update', message: updated });
            }
            emit({ type: 'status', status: this.getStatus() });
          },
          onDone: () => {
            const current = this.messages.find((message) => message.id === localAssistantId);
            if (current?.role === 'assistant') {
              const finalized = { ...current, isStreaming: false } as AssistantMessage;
              this.messages = this.messages.map((message) => message.id === localAssistantId ? finalized : message);
              appendMessage(finalized);
              this.historySignature = historySignature();
              this.markTaskActivityChanged(emit);
              emit({ type: 'assistant-final', message: finalized });
              // A finalized-but-empty reply (no error, no tokens) otherwise renders as a silent blank
              // bubble. Surface it so "no response" always says why.
              if (!finalized.content.trim() && !turnContext.signal.aborted) {
                emit({ type: 'toast', level: 'error', message: 'The model returned an empty response.' });
              }
            }
          },
          onError: (error) => {
            const current = this.messages.find((message) => message.id === localAssistantId);
            if (current?.role === 'assistant') {
              const failed = { ...current, content: `Error: ${error.message}`, isStreaming: false } as AssistantMessage;
              this.messages = this.messages.map((message) => message.id === localAssistantId ? failed : message);
              appendMessage(failed);
              this.historySignature = historySignature();
              this.markTaskActivityChanged(emit);
              emit({ type: 'assistant-final', message: failed });
            } else {
              emit({ type: 'error', message: error.message });
            }
          },
          onToolApproval: (toolName, args) => {
            return new Promise<boolean>((resolveApproval) => {
              const id = crypto.randomUUID();
              const request = { id, toolName, command: String(args.command ?? '') };
              this.pendingApprovals.set(id, { request, resolve: resolveApproval });
              emit({ type: 'tool-approval', request });
            });
          },
          onToolStart: (name) => {
            this.toolStatus = `Running ${name}...`;
            turnContext.setPhase('tool', name);
            emit({ type: 'status', status: this.getStatus() });
          },
          onToolEnd: () => {
            this.toolStatus = '';
            turnContext.setPhase('working');
            emit({ type: 'status', status: this.getStatus() });
          },
          onMemoryStart: () => {
            this.toolStatus = 'Recalling...';
            emit({ type: 'status', status: this.getStatus() });
          },
          onMemoryEnd: (inlineDisplay, queries) => {
            this.toolStatus = '';
            if (inlineDisplay) {
              const message: Message = { id: crypto.randomUUID(), role: 'tool', toolCallId: 'memory', toolName: '/memory', content: inlineDisplay, memoryLookup: { queries: queries ?? [] } };
              this.messages = [...this.messages, message];
              emit({ type: 'message', message });
            }
            emit({ type: 'status', status: this.getStatus() });
          },
          onStatus: (stage, detail) => {
            this.pipelineStatus = { stage, detail };
            turnContext.setPhase(stage === 'tool' ? 'tool' : stage === 'context' || stage.startsWith('memory') ? 'preparing' : 'working', detail ?? stage);
            emit({ type: 'status', status: this.getStatus() });
          },
        },
        turnContext.signal,
      );

      if (this.ingestQueue && this.config.index?.enabled) {
        const pairs = messagesToTurnPairs(newMessages, 'current', 'squirl');
        for (const pair of pairs) this.ingestQueue.enqueue(pair);
      }
    } finally {
      if (recipientId === SQUIRL_PARTICIPANT.id) {
        this.isStreaming = false;
        this.toolStatus = '';
        this.pipelineStatus = null;
      }
      emit({ type: 'status', status: this.getStatus() });
      emit({ type: 'done' });
    }
  }

  private participantLabel(id: string): string {
    return this.coordinator.listParticipants().find((p) => p.id === id)?.label ?? id;
  }

  private syncIdentityContext(): void {
    if (typeof this.orchestrator.setIdentityContext !== 'function') return;
    this.orchestrator.setIdentityContext({
      displayName: this.config.userProfile?.displayName,
      participants: this.coordinator.listParticipants().map(({ id, label, status, specialty }) => ({ id, label, status, specialty })),
    });
  }

  private markTaskActivityChanged(emit?: (event: ChatEvent) => void): void {
    this.taskSourceDirty = true;
    this.scheduleTaskActivityRefresh();
  }

  private scheduleTaskActivityRefresh(): void {
    this.taskRefreshQueued = true;
    if (this.taskRefreshRunning || this.taskRefreshScheduled) return;
    this.taskRefreshScheduled = true;
    queueMicrotask(() => {
      this.taskRefreshScheduled = false;
      void this.refreshTaskActivity();
    });
  }

  private emitTaskActivity(): void {
    const event: ChatEvent = { type: 'task-activity', taskActivity: this.getTaskActivityState() };
    this.taskActivityEmit?.(event);
    this.publish(event);
  }

  private async refreshTaskActivity(): Promise<void> {
    if (this.taskRefreshRunning) return;
    this.taskRefreshRunning = true;
    this.emitTaskActivity();
    try {
      while (this.taskRefreshQueued) {
        this.taskRefreshQueued = false;
        const llm = this.taskMetaLLM ?? this.routingMetaLLM;
        const embedder = this.embedder;
        const vectorStore = this.vectorStore;
        const historyEntries = getAllHistoryFiles().flatMap((file) => readEntries(file)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const evidence = buildRecentTaskEvidence(historyEntries);
        const sourceWatermark = taskEvidenceWatermark(evidence);
        if (sourceWatermark === this.taskActivitySnapshot?.sourceWatermark) {
          this.taskRefreshFailed = false;
          this.taskSourceDirty = false;
          this.updateTaskUncertainty();
          this.emitTaskActivity();
          continue;
        }
        const snapshot = await classifyCurrentTasks({
          evidence,
          llm,
          embedder,
          vectorStore,
          previous: this.taskActivitySnapshot,
          recallK: this.config.index?.recallK ?? 8,
          calendarEvents: this.calendarSnapshot?.events ?? [],
        });
        snapshot.sourceWatermark = sourceWatermark;
        saveTaskActivitySnapshot(snapshot);
        this.taskActivitySnapshot = snapshot;
        this.taskRefreshFailed = false;
        this.taskSourceDirty = false;
        this.updateTaskUncertainty();
        this.emitTaskActivity();
        if (this.config.calendar?.syncInferredTasks) void this.refreshCalendar();
      }
    } catch {
      this.taskRefreshFailed = true;
      this.updateTaskUncertainty();
    } finally {
      this.taskRefreshRunning = false;
      this.emitTaskActivity();
      if (this.taskRefreshQueued) this.scheduleTaskActivityRefresh();
    }
  }

  private async generateScrum(dateInput: string): Promise<string> {
    const llm = this.taskMetaLLM;
    const embedder = this.embedder;
    const vectorStore = this.vectorStore;
    if (!this.config.index?.enabled || !llm || !embedder || !vectorStore) {
      throw new Error('Scrum reports require semantic memory. Run /setup to configure the task index.');
    }
    const now = new Date();
    const cutoff = now.getTime() - TASK_ACTIVITY_WINDOW_MS;
    const currentTasks = this.getTaskActivityState(now.getTime()).tasks.filter((task) =>
      task.source !== 'calendar' && Date.parse(task.lastActiveAt) >= cutoff,
    );
    const report = await generateScrumReport({
      input: dateInput,
      entries: loadAllHistoryEntries(),
      currentTasks,
      llm,
      embedder,
      vectorStore,
      now,
      recallK: this.config.index.recallK ?? 8,
    });
    return formatScrumReport(report);
  }

  private currentCalendarEvents(): CalendarSnapshot['events'] {
    if (this.config.calendar?.enabled !== true || !loadCalendarTokens()) return [];
    return this.calendarSnapshot?.events ?? [];
  }

  private updateTaskUncertainty(now = Date.now()): void {
    const calendarEvents = this.currentCalendarEvents();
    const lastAskedAt = lastTaskClarificationAt(loadAllHistoryEntries().map((entry) => entry.message));
    const known = hasCurrentTask({
      // A fresh-looking prior snapshot is not proof of the current task when the
      // latest classification failed or new evidence has not been classified yet.
      snapshot: this.taskRefreshFailed || this.taskSourceDirty ? null : this.taskActivitySnapshot,
      calendarEvents,
      now,
      taskWindowMs: TASK_ACTIVITY_WINDOW_MS,
    });
    this.taskUnknownSince = known ? null : (this.taskUnknownSince ?? taskUncertaintyStart({
      snapshot: this.taskActivitySnapshot,
      calendarEvents,
      now,
      lastAskedAt,
    }) ?? now);
  }

  private checkTaskClarification(now = Date.now()): void {
    this.updateTaskUncertainty(now);
    const lastAskedAt = lastTaskClarificationAt(loadAllHistoryEntries().map((entry) => entry.message));
    if (!shouldAskTaskClarification({
      now,
      unknownSince: this.taskUnknownSince,
      lastAskedAt,
      isBusy: this.isStreaming || this.taskRefreshRunning,
    })) return;

    const message: AssistantMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: taskClarificationQuestion(this.config.userProfile?.displayName),
      proactiveKind: 'task-clarification',
      createdAt: new Date(now).toISOString(),
    };
    this.messages = [...this.messages, message];
    appendMessage(message);
    this.historySignature = historySignature();
    this.publish({ type: 'message', message });
  }

  private startTaskClarificationChecks(): void {
    if (this.taskClarificationTimer) clearInterval(this.taskClarificationTimer);
    this.taskUnknownSince = null;
    this.checkTaskClarification();
    this.taskClarificationTimer = setInterval(() => this.checkTaskClarification(), TASK_CLARIFICATION_CHECK_MS);
    this.taskClarificationTimer.unref?.();
  }

  /** Map the coordinator's AgentEvents onto the existing ChatEvent stream + this.messages. */
  private handleAgentEvent(event: AgentEvent): void {
    const emit = (chatEvent: ChatEvent) => this.publish(chatEvent);
    const pid = event.participantId === SQUIRL_PARTICIPANT.id ? undefined : event.participantId;
    switch (event.type) {
      case 'message-start': {
        const message: Message = { id: event.messageId, role: 'assistant', content: '', isStreaming: true, participantId: pid, responseMeta: event.responseMeta };
        this.messages = [...this.messages, message];
        emit({ type: 'message', message });
        break;
      }
      case 'token': {
        this.messages = this.messages.map((m) => (m.id === event.messageId && m.role === 'assistant' ? { ...m, content: m.content + event.token } : m));
        emit({ type: 'token', token: event.token, assistantId: event.messageId });
        break;
      }
      case 'message-end': {
        const current = this.messages.find((message) => message.id === event.messageId);
        const finalized: AssistantMessage = { id: event.messageId, role: 'assistant', content: event.content, isStreaming: false, participantId: pid, responseMeta: current?.role === 'assistant' ? current.responseMeta : undefined };
        this.messages = this.messages.map((m) => (m.id === event.messageId ? finalized : m));
        appendMessage(finalized);
        this.historySignature = historySignature();
        this.markTaskActivityChanged(emit);
        emit({ type: 'assistant-final', message: finalized });
        break;
      }
      case 'turn-end': {
        const participant = this.coordinator.listParticipants().find((candidate) => candidate.id === event.participantId);
        if (participant?.kind === 'claude-code' || participant?.kind === 'codex' || participant?.kind === 'pi') {
          const telemetry = this.coordinator.getContextTelemetry(participant.id);
          if (telemetry) {
            const preview = inspectParticipantContext(participant.kind, telemetry);
            if (preview.fidelity !== 'unavailable') {
              this.participantContextPreviews = { ...this.participantContextPreviews, [participant.id]: preview };
              saveParticipantContextPreviews(this.workingDir, this.participantContextPreviews);
            }
          }
        }
        break;
      }
      case 'tool-start': {
        this.turnScheduler.setPhase(event.participantId, 'tool', event.toolName);
        const key = event.toolId || `${event.participantId}:${event.toolName}`;
        const messageId = crypto.randomUUID();
        this.pendingTools.set(key, { messageId, input: event.input });
        const message: Message = {
          id: messageId, role: 'tool', toolCallId: event.toolId || key,
          toolName: `${this.participantLabel(event.participantId)}:${event.toolName}`,
          content: '', toolInput: event.input, toolStatus: 'running', participantId: event.participantId,
        };
        this.messages = [...this.messages, message];
        emit?.({ type: 'message', message });
        emit?.({ type: 'status', status: this.getStatus() });
        break;
      }
      case 'tool-end': {
        this.turnScheduler.setPhase(event.participantId, 'working');
        const key = event.toolId || `${event.participantId}:${event.toolName}`;
        const pending = this.pendingTools.get(key);
        this.pendingTools.delete(key);
        const bounded = boundedToolOutput(event.result);
        const message: Message = {
          id: pending?.messageId ?? crypto.randomUUID(), role: 'tool',
          toolCallId: event.toolId || crypto.randomUUID(),
          toolName: `${this.participantLabel(event.participantId)}:${event.toolName}`,
          content: bounded.content || (event.ok ? '(ok)' : '(failed)'),
          toolInput: pending?.input,
          toolStatus: event.ok ? 'success' : 'error',
          outputTruncated: bounded.truncated || undefined,
          participantId: event.participantId,
        };
        this.messages = pending
          ? this.messages.map((current) => current.id === pending.messageId ? message : current)
          : [...this.messages, message];
        appendMessage(message);
        emit?.(pending ? { type: 'assistant-final', message } : { type: 'message', message });
        emit?.({ type: 'status', status: this.getStatus() });
        break;
      }
      case 'session-status': {
        this.syncIdentityContext();
        emit?.({ type: 'agent-status', participantId: event.participantId, status: event.status });
        break;
      }
      case 'interaction-request': {
        if (!this.agentInteractions.some((item) => item.participantId === event.participantId && item.request.id === event.request.id)) {
          this.agentInteractions = [...this.agentInteractions, { participantId: event.participantId, request: event.request }];
        }
        emit?.({ type: 'agent-interaction', participantId: event.participantId, request: event.request });
        break;
      }
      case 'interaction-notify': {
        emit?.({ type: 'toast', level: event.level === 'error' ? 'error' : 'info', message: `${this.participantLabel(event.participantId)}: ${event.message}` });
        break;
      }
      case 'interaction-status': {
        this.turnScheduler.setPhase(event.participantId, event.text ? 'tool' : 'working', event.text);
        emit?.({ type: 'status', status: this.getStatus() });
        break;
      }
      case 'interaction-editor-prefill': {
        emit?.({ type: 'agent-editor-prefill', participantId: event.participantId, text: event.text });
        break;
      }
      case 'error': {
        const content = event.message.trim() || 'The connector failed without providing an error message.';
        if (this.lastAgentErrors.get(event.participantId) === content) break;
        this.lastAgentErrors.set(event.participantId, content);
        const label = this.participantLabel(event.participantId);
        const message: Message = {
          id: crypto.randomUUID(), role: 'tool', toolCallId: crypto.randomUUID(),
          toolName: `${label}:connector error`, content, toolStatus: 'error', participantId: event.participantId,
        };
        this.messages = [...this.messages, message];
        appendMessage(message);
        this.historySignature = historySignature();
        emit?.({ type: 'message', message });
        emit?.({ type: 'toast', level: 'error', message: `${label} failed. The full error is shown in the conversation.` });
        break;
      }
      default:
        break;
    }
  }

  /** Run a squirl local-LLM turn as a coordinator participant (used for handoffs). */
  private runLocalTurn(input: string, emit: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    let assistantId = '';
    let lastContent = '';
    return this.orchestrator.chat(input, this.messages, this.selectedModel, {
      onNewMessage: (msg) => {
        if (msg.role === 'assistant') { assistantId = msg.id; emit({ type: 'message-start', participantId: SQUIRL_PARTICIPANT.id, messageId: msg.id, responseMeta: { model: this.selectedModel.id } }); }
        else if (msg.role === 'tool') { emit({ type: 'tool-end', participantId: SQUIRL_PARTICIPANT.id, toolId: msg.toolCallId, toolName: msg.toolName, result: msg.content, ok: true }); }
      },
      onToken: (token, assistant) => { assistantId = assistant.id; lastContent = assistant.content; emit({ type: 'token', participantId: SQUIRL_PARTICIPANT.id, messageId: assistant.id, token }); },
      onDone: () => { if (assistantId) emit({ type: 'message-end', participantId: SQUIRL_PARTICIPANT.id, messageId: assistantId, content: lastContent }); emit({ type: 'turn-end', participantId: SQUIRL_PARTICIPANT.id }); },
      onError: (err) => { emit({ type: 'error', participantId: SQUIRL_PARTICIPANT.id, message: err.message }); emit({ type: 'turn-end', participantId: SQUIRL_PARTICIPANT.id }); },
      onToolApproval: (toolName, args) => new Promise<boolean>((resolve) => {
        const id = crypto.randomUUID();
        const request = { id, toolName, command: String(args.command ?? '') };
        this.pendingApprovals.set(id, { request, resolve });
        this.publish({ type: 'tool-approval', request });
      }),
    }, signal).then(() => undefined);
  }

  async addAgent(kind: AgentKind, opts?: { id?: string; model?: string; effort?: import('../types.js').EffortLevel; cwd?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; approvalPolicy?: CodexApprovalPolicy; piToolMode?: PiToolMode; piApprovalMode?: PiApprovalMode }): Promise<AddAgentResult> {
    try {
      if (opts?.permissionMode !== undefined && (kind !== 'claude-code' || !CLAUDE_PERMISSION_MODES.has(opts.permissionMode))) {
        throw new Error(kind === 'claude-code' ? `Unknown Claude permission mode "${String(opts.permissionMode)}".` : 'Claude permission mode is only supported by Claude Code agents.');
      }
      if (opts?.sandbox !== undefined && (kind !== 'codex' || !CODEX_SANDBOXES.has(opts.sandbox))) {
        throw new Error(kind === 'codex' ? `Unknown Codex sandbox "${String(opts.sandbox)}".` : 'Codex sandbox is only supported by Codex agents.');
      }
      if (opts?.approvalPolicy !== undefined && (kind !== 'codex' || !CODEX_APPROVAL_POLICIES.has(opts.approvalPolicy))) {
        throw new Error(kind === 'codex' ? `Unknown Codex approval policy "${String(opts.approvalPolicy)}".` : 'Codex approval policy is only supported by Codex agents.');
      }
      if (opts?.piApprovalMode !== undefined && (kind !== 'pi' || !PI_APPROVAL_MODES.has(opts.piApprovalMode))) {
        throw new Error(kind === 'pi' ? `Unknown PI approval mode "${String(opts.piApprovalMode)}".` : 'PI approval mode is only supported by PI agents.');
      }
      const existingIds = this.listAgents().map((agent) => agent.id);
      const id = opts?.id
        ? validateAgentHandle(opts.id, existingIds)
        : nextAvailableAgentId(kind, existingIds);
      const requestedCwd = resolveUserPath(opts?.cwd ?? this.workingDir);
      const cwd = resolve(this.workingDir, requestedCwd);
      if (opts?.cwd !== undefined) {
        if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
        if (!statSync(cwd).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
      }
      const codexDefaults = kind === 'codex' ? discoverCodexModels() : undefined;
      const descriptor = buildAgentDescriptor({
        kind, cwd, id, label: id, model: opts?.model ?? codexDefaults?.defaultModel, effort: opts?.effort,
        bin: kind === 'claude-code' ? this.config.agents?.claudeBin : kind === 'codex' ? resolveCodexBinary(this.config.agents?.codexBin) : resolvePiBinary(this.config.agents?.piBin),
        permissionMode: opts?.permissionMode ?? this.config.agents?.defaultClaudePermissionMode ?? 'acceptEdits',
        sandbox: opts?.sandbox ?? this.config.agents?.defaultCodexSandbox ?? 'workspace-write',
        approvalPolicy: opts?.approvalPolicy ?? this.config.agents?.defaultCodexApprovalPolicy ?? 'on-request',
        piToolMode: opts?.piToolMode ?? this.config.agents?.defaultPiToolMode,
        piApprovalMode: opts?.piApprovalMode ?? this.config.agents?.defaultPiApprovalMode ?? 'acceptEdits',
      });
      const participant = await this.coordinator.addAgent(descriptor);
      this.config = upsertAgentProfile(this.config, profileFromDescriptor(descriptor));
      this.persistConfig();
      return { ok: true, id: participant.id, label: participant.label };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stopAgent(id: string): Promise<boolean> {
    if (!this.coordinator.hasAgent(id)) return false;
    await this.coordinator.removeAgent(id);
    this.agentInteractions = this.agentInteractions.filter((item) => item.participantId !== id);
    this.config = removeAgentProfile(this.config, id);
    if (this.participantContextPreviews[id]) {
      const { [id]: _removed, ...remaining } = this.participantContextPreviews;
      this.participantContextPreviews = remaining;
      saveParticipantContextPreviews(this.workingDir, remaining);
    }
    this.persistConfig();
    return true;
  }

  async renameAgent(id: string, name: string): Promise<AddAgentResult> {
    return this.updateAgent(id, { name });
  }

  async updateAgent(id: string, updates: UpdateAgentOptions): Promise<AddAgentResult> {
    try {
      const allowedEfforts = new Set<EffortLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
      if (updates.effort != null && !allowedEfforts.has(updates.effort)) {
        throw new Error(`Unknown effort "${String(updates.effort)}".`);
      }
      if (updates.sandbox !== undefined && !CODEX_SANDBOXES.has(updates.sandbox)) {
        throw new Error(`Unknown Codex sandbox "${String(updates.sandbox)}".`);
      }
      if (updates.permissionMode !== undefined && !CLAUDE_PERMISSION_MODES.has(updates.permissionMode)) {
        throw new Error(`Unknown Claude permission mode "${String(updates.permissionMode)}".`);
      }
      if (updates.approvalPolicy !== undefined && !CODEX_APPROVAL_POLICIES.has(updates.approvalPolicy)) throw new Error(`Unknown Codex approval policy "${String(updates.approvalPolicy)}".`);
      if (updates.piApprovalMode !== undefined && !PI_APPROVAL_MODES.has(updates.piApprovalMode)) throw new Error(`Unknown PI approval mode "${String(updates.piApprovalMode)}".`);
      const nextId = validateAgentHandle(updates.name ?? id, this.listAgents().map((agent) => agent.id), id);
      const oldDescriptor = this.coordinator.getDescriptor(id);
      if (!oldDescriptor) throw new Error(`No agent "@${id}".`);
      if (updates.sandbox !== undefined && oldDescriptor.kind !== 'codex') {
        throw new Error('Codex sandbox is only supported by Codex agents.');
      }
      if (updates.permissionMode !== undefined && oldDescriptor.kind !== 'claude-code') {
        throw new Error('Claude permission mode is only supported by Claude Code agents.');
      }
      if (updates.approvalPolicy !== undefined && oldDescriptor.kind !== 'codex') throw new Error('Codex approval policy is only supported by Codex agents.');
      if (updates.piApprovalMode !== undefined && oldDescriptor.kind !== 'pi') throw new Error('PI approval mode is only supported by PI agents.');
      const oldProfile = this.config.agents?.defaults?.find((profile) => profile.id?.toLowerCase() === id.toLowerCase());

      const nextModel = updates.model === undefined
        ? oldDescriptor.model
        : updates.model?.trim() || undefined;
      const nextEffort = updates.effort === undefined ? oldDescriptor.effort : updates.effort ?? undefined;
      if (oldDescriptor.kind !== 'pi' && (nextEffort === 'off' || nextEffort === 'minimal')) {
        throw new Error(`${nextEffort} thinking is only supported by PI agents.`);
      }
      const nextPiToolMode = oldDescriptor.kind === 'pi'
        ? updates.piToolMode ?? oldDescriptor.piToolMode ?? 'coding'
        : undefined;
      const nextPiApprovalMode = oldDescriptor.kind === 'pi'
        ? updates.piApprovalMode ?? oldDescriptor.piApprovalMode ?? 'acceptEdits'
        : undefined;
      const nextSandbox = oldDescriptor.kind === 'codex'
        ? updates.sandbox ?? oldDescriptor.sandbox ?? 'workspace-write'
        : undefined;
      const nextApprovalPolicy = oldDescriptor.kind === 'codex'
        ? updates.approvalPolicy ?? oldDescriptor.approvalPolicy ?? 'on-request'
        : undefined;
      const nextPermissionMode = oldDescriptor.kind === 'claude-code'
        ? updates.permissionMode ?? oldDescriptor.permissionMode ?? 'acceptEdits'
        : undefined;
      let nextCwd = oldDescriptor.cwd;
      if (updates.cwd !== undefined) {
        const requestedCwd = resolveUserPath(updates.cwd.trim() || this.workingDir);
        nextCwd = resolve(this.workingDir, requestedCwd);
        if (!existsSync(nextCwd)) throw new Error(`Working directory does not exist: ${nextCwd}`);
        if (!statSync(nextCwd).isDirectory()) throw new Error(`Working directory is not a directory: ${nextCwd}`);
      }

      const launchSettingsChanged = nextModel !== oldDescriptor.model || nextEffort !== oldDescriptor.effort || nextCwd !== oldDescriptor.cwd || nextPermissionMode !== oldDescriptor.permissionMode || nextSandbox !== oldDescriptor.sandbox || nextApprovalPolicy !== oldDescriptor.approvalPolicy || nextPiToolMode !== oldDescriptor.piToolMode || nextPiApprovalMode !== oldDescriptor.piApprovalMode;
      const identityChanged = nextId !== id || nextId !== oldDescriptor.label;
      if (!launchSettingsChanged && !identityChanged) return { ok: true, id, label: oldDescriptor.label };

      const current = this.coordinator.listParticipants().find((participant) => participant.id === id);
      if (current?.status === 'busy') throw new Error(`Cannot edit @${id} while it is busy. Wait for the current turn to finish or cancel it first.`);

      const replacement = {
        ...oldDescriptor,
        id: nextId,
        label: nextId,
        cwd: nextCwd,
        model: nextModel,
        effort: nextEffort,
        permissionMode: nextPermissionMode,
        sandbox: nextSandbox,
        approvalPolicy: nextApprovalPolicy,
        piToolMode: nextPiToolMode,
        piApprovalMode: nextPiApprovalMode,
        ...(launchSettingsChanged ? { sessionId: undefined } : {}),
      };
      const participant = await this.coordinator.replaceAgent(id, replacement);

      this.config = removeAgentProfile(this.config, id);
      this.config = upsertAgentProfile(this.config, profileFromDescriptor(replacement, oldProfile?.profileId));

      if (launchSettingsChanged) {
        const remaining = { ...this.participantContextPreviews };
        delete remaining[id];
        delete remaining[nextId];
        this.participantContextPreviews = remaining;
      } else if (id !== nextId && this.participantContextPreviews[id]) {
        const { [id]: previous, ...remaining } = this.participantContextPreviews;
        this.participantContextPreviews = { ...remaining, [nextId]: { ...previous, participantId: nextId } };
      }
      saveParticipantContextPreviews(this.workingDir, this.participantContextPreviews);
      this.persistConfig();
      return { ok: true, id: participant.id, label: participant.label };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  listAgents(): AgentSummary[] {
    return this.coordinator.listParticipants()
      .filter((p: Participant) => p.kind !== 'user' && p.kind !== 'local-llm')
      .map((p) => ({ id: p.id, label: p.label, status: p.status ?? '?', mode: p.mode ?? '' }));
  }

  private async startDefaultAgents(): Promise<void> {
    const defaults = this.config.agents?.defaults;
    if (!defaults?.length) return;
    const migrated = [];
    for (const raw of defaults) {
      try {
        const profile = materializeProfile(raw, this.workingDir);
        if (!profile.reconnect) { migrated.push(profile); continue; }
        const codexDefaults = profile.kind === 'codex' ? discoverCodexModels() : undefined;
        const descriptor = buildAgentDescriptor({
            kind: profile.kind, cwd: profile.cwd, id: profile.id, label: profile.label, specialty: profile.specialty,
          model: profile.model ?? codexDefaults?.defaultModel, effort: profile.effort,
          bin: profile.bin ?? (profile.kind === 'claude-code' ? this.config.agents?.claudeBin : profile.kind === 'codex' ? resolveCodexBinary(this.config.agents?.codexBin) : resolvePiBinary(this.config.agents?.piBin)),
          permissionMode: profile.permissionMode ?? this.config.agents?.defaultClaudePermissionMode ?? 'acceptEdits',
          sandbox: profile.sandbox ?? this.config.agents?.defaultCodexSandbox ?? 'workspace-write',
          approvalPolicy: profile.approvalPolicy ?? this.config.agents?.defaultCodexApprovalPolicy ?? 'on-request',
          piToolMode: profile.piToolMode ?? this.config.agents?.defaultPiToolMode,
          piApprovalMode: profile.piApprovalMode ?? this.config.agents?.defaultPiApprovalMode ?? 'acceptEdits',
        });
        await this.coordinator.addAgent(descriptor);
        migrated.push(profileFromDescriptor(descriptor, profile.profileId));
      } catch (err) {
        this.emit('toast', { level: 'error', message: `Could not reconnect agent: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    this.config = { ...this.config, agents: { ...this.config.agents, defaults: migrated } };
    this.persistConfig();
  }

  private persistConfig(): void {
    saveConfig(this.config);
    this.configSignature = JSON.stringify(this.config);
  }

  async recall(query: string): Promise<Message> {
    this.refreshSharedState();
    if (!this.config.index?.enabled || !this.embedder || !this.vectorStore) {
      throw new Error('Index not enabled. Configure ChromaDB and an embedding provider first.');
    }
    try {
      const results = await recall(query, this.embedder, this.vectorStore, 5);
      const content = results.length === 0
        ? 'No results found.'
        : results.map((r, i) => `${i + 1}. [${r.turnPair.source}] ${r.turnPair.timestamp.slice(0, 10)} (score: ${r.score.toFixed(3)})\nQ: ${r.turnPair.userText.slice(0, 100)}\nA: ${r.turnPair.assistantText.slice(0, 200)}`).join('\n\n');
      const message: Message = { id: crypto.randomUUID(), role: 'tool', toolCallId: 'recall', toolName: '/recall', content };
      this.messages = [...this.messages, message];
      return message;
    } catch (err) {
      throw new Error(isVectorStoreError(err) ? err.message : err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Eval dashboard ----

  getEvalHistory(): HistoryEntry[] {
    return readHistory();
  }

  /** Run an eval layer in-process, streaming coarse progress, and append a history entry. */
  async runEval(req: EvalRunRequest, emit: (event: EvalEvent) => void): Promise<void> {
    this.refreshConfigFromDisk();
    const config = evalConfigFromSquirl(this.config, req);

    const deps: Parameters<typeof executeEvalRun>[1] = {};
    if (config.layer === 3) {
      deps.answerModel = answerModelFromSquirl(this.config);
      const judge = judgeFromSquirl(this.config);
      deps.judgeLLM = judge.llm;
      deps.judgeLabel = `${judge.provider}:${judge.model}`;
    }

    const result = await executeEvalRun(config, deps, (e) => emit({ type: 'progress', stage: e.stage, ...(e.detail ? { detail: e.detail } : {}) }));
    emit({ type: 'result', result });
    emit({ type: 'done' });
  }

  /** (Re)start the self-monitoring timer from config.eval.monitor. Default off; safe to call repeatedly. */
  startEvalMonitor(): void {
    if (this.evalMonitorTimer) {
      clearInterval(this.evalMonitorTimer);
      this.evalMonitorTimer = null;
    }
    const monitor = this.config.eval?.monitor;
    if (!monitor?.enabled) return;

    const intervalHours = monitor.intervalHours ?? 24;
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    const layer = (monitor.layer ?? 1) as 1 | 2 | 3;
    const mode = monitor.mode ?? 'frozen';

    // Run once on startup if the latest matching run is stale (or there is none).
    const latest = this.getEvalHistory().filter((e) => e.layer === layer && e.mode === mode).pop();
    const stale = !latest || (Date.now() - new Date(latest.timestamp).getTime()) >= intervalMs;
    if (stale) void this.runMonitorEval(layer, mode);

    this.evalMonitorTimer = setInterval(() => void this.runMonitorEval(layer, mode), intervalMs);
  }

  stopEvalMonitor(): void {
    if (this.evalMonitorTimer) clearInterval(this.evalMonitorTimer);
    this.evalMonitorTimer = null;
  }

  private async runMonitorEval(layer: 1 | 2 | 3, mode: 'frozen' | 'live'): Promise<void> {
    if (this.evalMonitorRunning) return; // never overlap runs
    this.evalMonitorRunning = true;
    try {
      await this.runEval({ layer, mode, label: 'monitor' }, () => {});
    } catch (err) {
      console.error('[eval-monitor] run failed:', err instanceof Error ? err.message : String(err));
    } finally {
      this.evalMonitorRunning = false;
    }
  }

  // ---- Dependency health checks ----

  /** Start the periodic dependency health checks (first run shortly after boot, then every 30s). */
  startHealthChecks(): void {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    setTimeout(() => void this.refreshHealth(), 2_000); // let index init settle first
    this.healthTimer = setInterval(() => void this.refreshHealth(), 30_000);
  }

  stopHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Probe every configured dependency concurrently and cache the snapshot. Non-overlapping. */
  async refreshHealth(): Promise<void> {
    if (this.healthChecking) return;
    this.healthChecking = true;
    try {
      const targets = buildHealthTargets(this.config, this.selectedModel);
      const entries = await Promise.all(targets.map((t) => this.probeTarget(t)));
      this.healthReport = { entries, checkedAt: new Date().toISOString() };
    } finally {
      this.healthChecking = false;
    }
  }

  private probeTarget(target: ReturnType<typeof buildHealthTargets>[number]): Promise<HealthEntry> {
    if (target.kind === 'embedder') {
      if (!this.embedder) return Promise.resolve({ id: target.id, label: target.label, state: 'down', detail: 'embedder not initialized' });
      return probeEmbedder(this.embedder, target.label);
    }
    if (target.kind === 'vectorstore') {
      if (!this.vectorStore) return Promise.resolve({ id: target.id, label: target.label, state: 'down', detail: 'vector store not initialized' });
      return probeVectorStore(this.vectorStore, target.label);
    }
    return probeChat(target, this.listModelsFor(target));
  }

  private listModelsFor(target: ReturnType<typeof buildHealthTargets>[number]): () => Promise<string[]> {
    if (target.provider === 'openai') {
      return () => fetchModelIds('https://api.openai.com/v1/models', { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` }, process.env.OPENAI_API_KEY);
    }
    if (target.provider === 'anthropic') {
      return () => fetchModelIds('https://api.anthropic.com/v1/models', { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' }, process.env.ANTHROPIC_API_KEY);
    }
    const baseUrl = target.baseUrl ?? this.config.localBaseUrl ?? 'http://localhost:8000/v1';
    return () => fetchAvailableModels(baseUrl).then((models) => models.map((m) => m.id));
  }

  private refreshSharedState(): void {
    this.refreshConfigFromDisk();
    if (this.refreshHistoryFromDisk()) this.markTaskActivityChanged();
  }

  private async refreshSharedStateAsync(): Promise<void> {
    const configChanged = this.refreshConfigFromDisk();
    const historyChanged = this.refreshHistoryFromDisk();
    if (configChanged) {
      await this.initializeIndex();
      await this.hydrateSelectedLocalModel();
    } else {
      await this.hydrateSelectedLocalModel();
    }
    if (configChanged || historyChanged) this.markTaskActivityChanged();
  }

  private refreshConfigFromDisk(): boolean {
    if (this.isStreaming) return false;
    const next = loadConfig();
    const nextSignature = JSON.stringify(next);
    if (nextSignature === this.configSignature) return false;

    const currentModel = JSON.stringify(defaultModelFromConfig(this.config));
    const nextModel = JSON.stringify(defaultModelFromConfig(next));
    this.config = next;
    applyConfigToEnv(next);
    this.configSignature = nextSignature;

    if (currentModel !== nextModel || this.selectedModel.provider !== next.defaultProvider) {
      this.selectedModel = defaultModelFromConfig(next);
    }
    return true;
  }

  private refreshHistoryFromDisk(): boolean {
    if (this.isStreaming) return false;
    const nextSignature = historySignature();
    if (nextSignature === this.historySignature) return false;
    this.messages = loadHistory();
    this.historySignature = nextSignature;
    return true;
  }

  private async initializeIndex(): Promise<void> {
    this.orchestrator.setMemoryPipeline(null);
    this.embedder = null;
    this.vectorStore = null;
    this.ingestQueue = null;
    this.taskMetaLLM = null;
    this.embedderDisplay = '';
    if (!this.config.index?.enabled) return;

    const storeConfig = {
      type: this.config.index.store,
      chromaUrl: this.config.index.chromaUrl,
      chromaAuthToken: this.config.index.chromaAuthToken,
      collection: this.config.index.collection,
    } as const;

    try {
      const rawEmbedderUrl = this.config.index.embedderUrl ?? (this.config.index as { ollamaUrl?: string }).ollamaUrl;
      const embedderUrl = rawEmbedderUrl?.endsWith('/v1') ? rawEmbedderUrl : rawEmbedderUrl ? rawEmbedderUrl.replace(/\/+$/, '') + '/v1' : undefined;
      const embedderBackend = embedderUrl ? await detectLocalBackend(embedderUrl) : undefined;
      let embedderModel = this.config.index.embedderModel;
      let embedderMaxTokens = 512;
      if (embedderUrl && embedderBackend) {
        const models = await fetchAvailableModels(embedderUrl, embedderBackend);
        if (models.length > 0) {
          if (!embedderModel) embedderModel = models[0]!.id;
          const match = models.find((model) => model.id === embedderModel);
          if (match?.contextWindow) embedderMaxTokens = match.contextWindow;
        }
      }

      const backendLabel = embedderBackend ? BACKEND_DISPLAY_NAMES[embedderBackend] || embedderBackend : '';
      this.embedderDisplay = this.config.index.embedder === 'local' && embedderModel
        ? `${embedderModel}${backendLabel ? ` (${backendLabel})` : ''}`
        : this.config.index.embedder === 'openai'
          ? `openai / ${embedderModel ?? 'text-embedding-3-small'}`
          : '';

      this.embedder = createEmbedder({
        type: this.config.index.embedder,
        apiKey: this.config.openaiApiKey,
        model: embedderModel,
        baseUrl: embedderUrl,
        detectedBackend: embedderBackend,
      });
      this.vectorStore = await createVectorStore(storeConfig);
      this.ingestQueue = new IngestQueue(this.embedder, this.vectorStore, this.statusEmitter, embedderMaxTokens);

      const metaLLM = createConfiguredMetaLLM(this.config);
      this.taskMetaLLM = metaLLM;
      this.orchestrator.setMemoryPipeline(new MemoryPipeline(metaLLM, this.embedder, this.vectorStore, {
        recallK: this.config.index.recallK ?? 10,
      }));

      const files = getAllHistoryFiles();
      const entries = files.flatMap((file) => readEntries(file));
      await backfillFromHistory(this.ingestQueue, this.vectorStore, entries);
    } catch (err) {
      const message = formatVectorStoreStartupError(err, storeConfig);
      this.statusEmitter.update({ phase: 'error', pending: 0, error: message });
      this.emit('toast', { level: 'error', message });
    }
  }

  private async hydrateSelectedLocalModel(): Promise<void> {
    if (this.selectedModel.provider !== 'local' || !this.selectedModel.baseUrl) return;
    const backend = this.selectedModel.backend ?? await detectLocalBackend(this.selectedModel.baseUrl);
    const models = await fetchAvailableModels(this.selectedModel.baseUrl, backend);
    const match = models.find((model) => model.id === this.selectedModel.id);
    this.selectedModel = {
      ...this.selectedModel,
      backend,
      ...(match?.contextWindow ? { contextWindow: match.contextWindow } : {}),
    };
    this.persistContextWindow();
  }

  /** Persist the selected model's context window when we know it, so it survives restarts. */
  private persistContextWindow(): void {
    const window = resolveContextWindow(this.selectedModel, this.config);
    if (!window) return;
    const next = rememberContextWindow(this.config, this.selectedModel.id, window);
    if (next === this.config) return;
    this.config = next;
    saveConfig(this.config);
    // Keep the signature in sync with our own write, so the periodic disk poll
    // (refreshConfigFromDisk) doesn't mistake it for an external edit and reset the model.
    this.configSignature = JSON.stringify(this.config);
  }

  private modelDisplay(): string {
    if (this.selectedModel.provider !== 'local') return this.selectedModel.label;
    if (this.selectedModel.backend && this.selectedModel.backend !== 'unknown') {
      return `${this.selectedModel.id} (${BACKEND_DISPLAY_NAMES[this.selectedModel.backend]})`;
    }
    return this.selectedModel.id;
  }

  /** Per-bucket context token estimate (system prompt / attached files / conversation), feeding both the
   *  status-bar count and the context-budget disc grid. Mirrors the TUI ContextPicker's tokenBuckets. */
  private contextBreakdown(): { system: number; files: number; messages: number } {
    const config = getModelConfig(this.selectedModel.id);
    const systemPrompt = buildSystemPrompt(
      {
        workingDir: this.workingDir,
        date: new Date().toISOString().slice(0, 10),
        modelId: this.selectedModel.id,
        platform: platform(),
        shell: process.env.SHELL ?? 'unknown',
        supportsTools: config.supportsTools,
        displayName: this.config.userProfile?.displayName,
        participants: this.coordinator.listParticipants().map(({ id, label, status, specialty }) => ({ id, label, status, specialty })),
      },
      config.systemPromptStyle,
    );
    const sysContent = typeof systemPrompt.content === 'string' ? systemPrompt.content : '';
    let files = 0;
    for (const content of this.orchestrator.getContextFiles().values()) files += estimateTokens(content);
    let messages = 0;
    for (const message of this.messages) messages += estimateTokens(message.content);
    return { system: estimateTokens(sysContent), files, messages };
  }

  workspaceInfo(path = '.'): { path: string; isDirectory: boolean; size: number } {
    const target = resolve(this.workingDir, path);
    const stat = statSync(target);
    return { path: target, isDirectory: stat.isDirectory(), size: stat.size };
  }
}
