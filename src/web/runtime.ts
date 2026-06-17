import { EventEmitter } from 'node:events';
import { homedir, platform } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

import { Orchestrator } from '../orchestrator.js';
import { getModelConfig } from '../model-config.js';
import { buildSystemPrompt } from '../context/system-prompt.js';
import { estimateTokens } from '../context/token-estimator.js';
import { loadConfig, saveConfig, applyConfigToEnv, type SquirlConfig } from '../config.js';
import { appendMessage, loadHistory, appendImportMessage, getAllHistoryFiles, readEntries, rewindHistoryAfter } from '../history.js';
import { detectLocalBackend, fetchAvailableModels, streamChatCompletion, BACKEND_DISPLAY_NAMES } from '../api.js';
import { getCommands, matchCommand } from '../commands/registry.js';
import { buildRewindCandidates, rewindRequestFromCandidate, type RewindRequest } from '../rewind.js';
import { messagesToTurnPairs } from '../search/turn-pair.js';
import { createEmbedder } from '../search/embedders/index.js';
import { createVectorStore, formatVectorStoreStartupError } from '../search/stores/index.js';
import { IngestQueue } from '../search/ingest-queue.js';
import { StatusEmitter } from '../search/status.js';
import { MemoryPipeline } from '../search/memory-pipeline.js';
import { OpenAIMetaLLM, AnthropicMetaLLM } from '../search/meta-llm.js';
import { recall } from '../search/recall.js';
import { isVectorStoreError } from '../search/stores/chroma.js';
import { backfillFromHistory } from '../search/backfill.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { Message, AssistantMessage } from '../types.js';
import type { QueryPipelineStatus } from '../pipeline-status.js';
import type { VectorStore } from '../search/types.js';
import type { MetaLLM } from '../search/meta-extract.js';
import type { AppState, ChatEvent, ContextFileSummary, ImportRequest, ImportResult, ModelDetectionResult, RuntimeStatus, ToolApprovalRequest } from './types.js';

interface PendingApproval {
  request: ToolApprovalRequest;
  resolve: (approved: boolean) => void;
}

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
    };
  }
  return { id: config?.defaultModel ?? 'claude-sonnet-4-6', label: config?.defaultModel ?? 'Claude Sonnet 4.6', provider: 'anthropic' };
}

function resolveUserPath(path: string): string {
  return path.trim().replace(/\\ /g, ' ').replace(/^~/, process.env.HOME ?? '');
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
  private abortController: AbortController | null = null;
  private isStreaming = false;
  private toolStatus = '';
  private pipelineStatus: QueryPipelineStatus | null = null;
  private tokensPerSecond = 0;
  private streamStart = 0;
  private streamTokens = 0;
  private embedderDisplay = '';
  private pendingApprovals = new Map<string, PendingApproval>();
  private historySignature = '';
  private configSignature = '';

  constructor(workingDir = process.cwd()) {
    super();
    this.workingDir = workingDir;
    this.config = loadConfig();
    applyConfigToEnv(this.config);
    this.messages = loadHistory();
    this.selectedModel = defaultModelFromConfig(this.config);
    this.orchestrator = new Orchestrator(workingDir);
    void this.initializeIndex();
    void this.hydrateSelectedLocalModel();
  }

  getState(): AppState {
    this.refreshSharedState();
    return {
      config: this.config,
      messages: this.messages,
      status: this.getStatus(),
      contextFiles: this.getContextFiles(),
      commands: getCommands().map(({ name, description }) => ({ name, description })),
    };
  }

  getStatus(): RuntimeStatus {
    const contextWindow = this.selectedModel.contextWindow ?? getModelConfig(this.selectedModel.id).contextWindow;
    return {
      selectedModel: this.selectedModel,
      modelDisplay: this.modelDisplay(),
      workingDir: this.workingDir,
      tokenCount: this.tokenCount(),
      contextWindow,
      isStreaming: this.isStreaming,
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

  async updateConfig(next: SquirlConfig): Promise<AppState> {
    this.config = next;
    applyConfigToEnv(next);
    saveConfig(next);
    this.selectedModel = defaultModelFromConfig(next);
    await this.initializeIndex();
    await this.hydrateSelectedLocalModel();
    this.configSignature = '';
    return this.getState();
  }

  async selectModel(model: SelectedModel): Promise<AppState> {
    this.selectedModel = model;
    await this.hydrateSelectedLocalModel();
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

  getContextFiles(): ContextFileSummary[] {
    return Array.from(this.orchestrator.getContextFiles().entries()).map(([path, content]) => ({
      path,
      chars: content.length,
      tokens: estimateTokens(content),
    }));
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

  cancel(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    this.abortController = null;
    this.isStreaming = false;
    this.toolStatus = '';
    this.pipelineStatus = null;
    return true;
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

  async chat(input: string, emit: (event: ChatEvent) => void): Promise<void> {
    const value = input.trim();
    if (!value) return;
    if (this.isStreaming) throw new Error('A message is already streaming.');

    const command = matchCommand(value);
    if (command) {
      this.refreshSharedState();
      await command.execute({
        orchestrator: this.orchestrator,
        messages: this.messages,
        workingDir: this.workingDir,
        modelId: this.selectedModel.id,
        setMessages: (fn) => { this.messages = fn(this.messages); },
        openContextPicker: () => emit({ type: 'toast', level: 'info', message: 'Open the Context panel to manage files.' }),
        openSetup: () => emit({ type: 'toast', level: 'info', message: 'Open Settings to change provider, keys, or index settings.' }),
        embedder: this.embedder ?? undefined,
        vectorStore: this.vectorStore ?? undefined,
        indexEnabled: this.config.index?.enabled ?? false,
        recallQuery: value.startsWith('/recall ') ? value.slice(8).trim() : '',
        commandInput: value,
        requestRewind: (request) => { void this.rewind(request).then((state) => emit({ type: 'state', state })).catch((err) => emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })); },
        openRewindPicker: () => emit({ type: 'toast', level: 'info', message: 'Open the Rewind panel to choose a visual target.' }),
      });
      emit({ type: 'state', state: this.getState() });
      return;
    }

    await this.refreshSharedStateAsync();
    this.isStreaming = true;
    this.tokensPerSecond = 0;
    this.streamStart = Date.now();
    this.streamTokens = 0;
    this.abortController = new AbortController();
    emit({ type: 'status', status: this.getStatus() });

    try {
      const priorMessages = this.messages;
      const newMessages = await this.orchestrator.chat(
        value,
        priorMessages,
        this.selectedModel,
        {
          onNewMessage: (message) => {
            this.messages = [...this.messages, message];
            if (message.role !== 'assistant') {
              appendMessage(message);
              this.historySignature = historySignature();
            }
            emit({ type: 'message', message });
          },
          onToken: (token, assistant) => {
            if (token) this.streamTokens++;
            const elapsed = (Date.now() - this.streamStart) / 1000;
            if (elapsed > 0.5) this.tokensPerSecond = Math.round(this.streamTokens / elapsed);
            const last = this.messages[this.messages.length - 1];
            if (last?.role === 'assistant' && last.isStreaming && last.id === assistant.id) {
              this.messages = [...this.messages.slice(0, -1), assistant];
              emit({ type: 'assistant-update', message: assistant });
            }
            emit({ type: 'status', status: this.getStatus() });
          },
          onDone: () => {
            const last = this.messages[this.messages.length - 1];
            if (last?.role === 'assistant') {
              const finalized = { ...last, isStreaming: false } as AssistantMessage;
              this.messages = [...this.messages.slice(0, -1), finalized];
              appendMessage(finalized);
              this.historySignature = historySignature();
              emit({ type: 'assistant-final', message: finalized });
            }
          },
          onError: (error) => {
            const last = this.messages[this.messages.length - 1];
            if (last?.role === 'assistant') {
              const failed = { ...last, content: `Error: ${error.message}`, isStreaming: false } as AssistantMessage;
              this.messages = [...this.messages.slice(0, -1), failed];
              appendMessage(failed);
              this.historySignature = historySignature();
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
            emit({ type: 'status', status: this.getStatus() });
          },
          onToolEnd: () => {
            this.toolStatus = '';
            emit({ type: 'status', status: this.getStatus() });
          },
          onMemoryStart: () => {
            this.toolStatus = 'Recalling...';
            emit({ type: 'status', status: this.getStatus() });
          },
          onMemoryEnd: (inlineDisplay) => {
            this.toolStatus = '';
            if (inlineDisplay) {
              const message: Message = { id: crypto.randomUUID(), role: 'tool', toolCallId: 'memory', toolName: '/memory', content: inlineDisplay };
              this.messages = [...this.messages, message];
              emit({ type: 'message', message });
            }
            emit({ type: 'status', status: this.getStatus() });
          },
          onStatus: (stage, detail) => {
            this.pipelineStatus = { stage, detail };
            emit({ type: 'status', status: this.getStatus() });
          },
        },
        this.abortController.signal,
      );

      if (this.ingestQueue && this.config.index?.enabled) {
        const pairs = messagesToTurnPairs(newMessages, 'current', 'squirl');
        for (const pair of pairs) this.ingestQueue.enqueue(pair);
      }
    } finally {
      this.isStreaming = false;
      this.toolStatus = '';
      this.pipelineStatus = null;
      this.abortController = null;
      emit({ type: 'status', status: this.getStatus() });
      emit({ type: 'done' });
    }
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

  private refreshSharedState(): void {
    this.refreshConfigFromDisk();
    this.refreshHistoryFromDisk();
  }

  private async refreshSharedStateAsync(): Promise<void> {
    const configChanged = this.refreshConfigFromDisk();
    this.refreshHistoryFromDisk();
    if (configChanged) {
      await this.initializeIndex();
      await this.hydrateSelectedLocalModel();
    } else {
      await this.hydrateSelectedLocalModel();
    }
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

      const metaProvider = this.config.index.metaProvider ?? this.config.defaultProvider ?? 'openai';
      const metaModel = this.config.index.metaModel ?? (metaProvider === 'local' ? (this.config.defaultModel ?? 'default') : 'gpt-4o-mini');
      const metaLLM: MetaLLM = metaProvider === 'anthropic'
        ? new AnthropicMetaLLM({ model: metaModel })
        : new OpenAIMetaLLM({ model: metaModel, ...(metaProvider === 'local' ? { baseUrl: this.config.localBaseUrl } : {}) });
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
  }

  private modelDisplay(): string {
    if (this.selectedModel.provider !== 'local') return this.selectedModel.label;
    if (this.selectedModel.backend && this.selectedModel.backend !== 'unknown') {
      return `${this.selectedModel.id} (${BACKEND_DISPLAY_NAMES[this.selectedModel.backend]})`;
    }
    return this.selectedModel.id;
  }

  private tokenCount(): number {
    const config = getModelConfig(this.selectedModel.id);
    const systemPrompt = buildSystemPrompt(
      {
        workingDir: this.workingDir,
        date: new Date().toISOString().slice(0, 10),
        modelId: this.selectedModel.id,
        platform: platform(),
        shell: process.env.SHELL ?? 'unknown',
        supportsTools: config.supportsTools,
      },
      config.systemPromptStyle,
    );
    const sysContent = typeof systemPrompt.content === 'string' ? systemPrompt.content : '';
    let total = estimateTokens(sysContent);
    for (const content of this.orchestrator.getContextFiles().values()) total += estimateTokens(content);
    for (const message of this.messages) total += estimateTokens(message.content) + 4;
    return total;
  }

  workspaceInfo(path = '.'): { path: string; isDirectory: boolean; size: number } {
    const target = resolve(this.workingDir, path);
    const stat = statSync(target);
    return { path: target, isDirectory: stat.isDirectory(), size: stat.size };
  }
}
