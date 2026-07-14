import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { RoomRoster } from './components/RoomRoster.js';
import { InputArea } from './components/InputArea.js';
import { RecipientPicker } from './components/RecipientPicker.js';
import { StatusBar } from './components/StatusBar.js';
import { ModelPicker } from './components/ModelPicker.js';
import { ContextPicker } from './components/ContextPicker.js';
import { CommandPalette, type PaletteAction } from './components/CommandPalette.js';
import { ToastContainer, type ToastMessage } from './components/Toast.js';
import { Orchestrator } from './orchestrator.js';
import { getModelConfig, resolveContextWindow } from './model-config.js';
import { loadConfig, saveConfig, rememberContextWindow } from './config.js';
import { loadHistory, appendMessage, readEntries, getAllHistoryFiles, loadAllHistoryEntries, rewindHistoryAfter } from './history.js';
import { matchCommand, filterCommands } from './commands/registry.js';
import { buildRewindCandidates, rewindRequestFromCandidate } from './rewind.js';
import type { RewindRequest } from './rewind.js';
import { estimateTokens } from './context/token-estimator.js';
import { buildSystemPrompt } from './context/system-prompt.js';
import { useMouseWheel } from './hooks/useMouseWheel.js';
import { enableMouseTracking, disableMouseTracking } from './mouse-filter.js';
import { platform } from 'node:os';
import { fetchAvailableModels, detectLocalBackend, BACKEND_DISPLAY_NAMES } from './api.js';
import type { SelectedModel } from './components/ModelPicker.js';
import type { SquirlConfig } from './config.js';
import { createEmbedder } from './search/embedders/index.js';
import { createVectorStore, formatVectorStoreStartupError } from './search/stores/index.js';
import { IngestQueue } from './search/ingest-queue.js';
import { StatusEmitter } from './search/status.js';
import { messagesToTurnPairs } from './search/turn-pair.js';
import { backfillFromHistory } from './search/backfill.js';
import type { VectorStore } from './search/types.js';
import { MemoryPipeline } from './search/memory-pipeline.js';
import { OpenAIMetaLLM, AnthropicMetaLLM, createConfiguredMetaLLM } from './search/meta-llm.js';
import type { MetaLLM } from './search/meta-extract.js';
import type { Message, AssistantMessage, ResponseMeta } from './types.js';
import { formatPipelineStatus, type QueryPipelineStatus } from './pipeline-status.js';
import { applyScrollDelta, nextAutoscrollEnabled, nextStreamingScrollOffset } from './scroll-behavior.js';
import { GroupChatCoordinator } from './agents/coordinator.js';
import { ParticipantTurnScheduler, type ParticipantTurn, type ParticipantWorkState, type TurnExecutionContext } from './agents/turn-scheduler.js';
import { LocalSpawnTransport } from './agents/transport/local-spawn.js';
import { buildAgentDescriptor } from './agents/factory.js';
import { SQUIRL_PARTICIPANT, USER_PARTICIPANT } from './agents/participants.js';
import { materializeProfile, nextAvailableAgentId, profileFromDescriptor, removeAgentProfile, upsertAgentProfile, validateAgentHandle } from './agents/profiles.js';
import { delegationConfirmationResponse, delegationConfirmationText, recoverPendingDelegation, resolveDelegationIntent, type DelegationAgent, type DelegationIntent } from './agents/delegation.js';
import type { AgentEvent, AgentInteractionRequest, AgentInteractionResponse, AgentKind, Participant } from './agents/types.js';
import { boundedToolOutput } from './tool-activity.js';
import { discoverCodexModels, resolveCodexBinary } from './agents/codex-models.js';
import { resolvePiBinary } from './agents/pi-models.js';
import { TASK_ACTIVITY_WINDOW_MS } from './tasks/evidence.js';
import { loadTaskActivitySnapshot } from './tasks/store.js';
import { formatScrumReport, generateScrumReport } from './tasks/scrum.js';

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

const ImportPrompt: React.FC<{ onSubmit: (path: string) => void; onClose: () => void }> = ({ onSubmit, onClose }) => {
  const [value, setValue] = useState('');
  useInput((_input, key) => {
    if (key.escape) onClose();
  });
  return (
    <Box borderStyle="single" borderTop={true} borderBottom={true} borderLeft={false} borderRight={false} paddingX={1}>
      <Text color="yellow" bold>{'import ❯ '}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={onSubmit} placeholder="~/Downloads/chatgpt-export" focus={true} />
    </Box>
  );
};

const ApprovalPrompt: React.FC<{ command: string; onRespond: (approved: boolean) => void }> = ({ command, onRespond }) => {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onRespond(true);
    else if (input === 'n' || input === 'N' || key.escape) onRespond(false);
  });
  return (
    <Box borderStyle="single" borderTop={true} borderBottom={true} borderLeft={false} borderRight={false} paddingX={1} gap={1}>
      <Text color="red" bold>{'⚠ '}</Text>
      <Text>Network command: <Text color="yellow">{command}</Text>  <Text dimColor>Allow? (y/n)</Text></Text>
    </Box>
  );
};

const AgentInteractionPrompt: React.FC<{
  participantId: string;
  request: AgentInteractionRequest;
  onRespond: (response: AgentInteractionResponse) => void;
}> = ({ participantId, request, onRespond }) => {
  const [value, setValue] = useState(request.method === 'editor' ? request.prefill ?? '' : '');
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if (key.escape) onRespond({ cancelled: true });
    else if (request.method === 'permission' && (input === 'd' || input === 'D')) onRespond({ decision: 'deny' });
    else if (request.method === 'permission' && (input === 'o' || input === 'O')) onRespond({ decision: 'allow-once' });
    else if (request.method === 'permission' && request.sessionScope && (input === 's' || input === 'S')) onRespond({ decision: 'allow-session' });
    else if (request.method === 'confirm' && (input === 'y' || input === 'Y')) onRespond({ confirmed: true });
    else if (request.method === 'confirm' && (input === 'n' || input === 'N')) onRespond({ confirmed: false });
    else if (request.method === 'select' && key.upArrow) setSelected((index) => Math.max(0, index - 1));
    else if (request.method === 'select' && key.downArrow) setSelected((index) => Math.min(request.options.length - 1, index + 1));
    else if (request.method === 'select' && key.return && request.options[selected]) onRespond({ value: request.options[selected] });
  });
  return <Box flexDirection="column" borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} paddingX={1}>
    <Text color="magenta" bold>{request.title || `Request from @${participantId}`}</Text>
    {request.message && <Text>{request.message}</Text>}
    {request.method === 'permission' && <>
      {request.resource && <Text color="yellow">{request.resource}</Text>}
      <Text dimColor>o allow once · {request.sessionScope ? 's allow for session · ' : ''}d deny</Text>
    </>}
    {request.method === 'confirm' && <Text dimColor>y yes · n no · esc cancel</Text>}
    {request.method === 'select' && request.options.map((option, index) => <Text key={option} color={index === selected ? 'cyan' : undefined}>{index === selected ? '› ' : '  '}{option}</Text>)}
    {(request.method === 'input' || request.method === 'editor') && <Box><Text color="cyan">{'› '}</Text><TextInput value={value} onChange={setValue} onSubmit={() => onRespond({ value })} placeholder={request.method === 'input' ? request.placeholder : undefined} focus /></Box>}
  </Box>;
};

const RewindPrompt: React.FC<{ request: RewindRequest; onRespond: (approved: boolean) => void }> = ({ request, onRespond }) => {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onRespond(true);
    else if (input === 'n' || input === 'N' || key.escape) onRespond(false);
  });
  return (
    <Box borderStyle="single" borderTop={true} borderBottom={true} borderLeft={false} borderRight={false} paddingX={1} gap={1}>
      <Text color="yellow" bold>{'↩ '}</Text>
      <Text>
        Rewind to <Text color="cyan">{request.label}</Text>; remove {request.removedCount} message{request.removedCount === 1 ? '' : 's'}? <Text dimColor>(y/n)</Text>
      </Text>
    </Box>
  );
};

const RewindModePrompt: React.FC<{
  selectedCandidate: ReturnType<typeof buildRewindCandidates>[number] | undefined;
  selectedIndex: number;
  candidateCount: number;
  onMove: (direction: -1 | 1) => void;
  onSelect: () => void;
  onClose: () => void;
}> = ({ selectedCandidate, selectedIndex, candidateCount, onMove, onSelect, onClose }) => {
  useInput((_input, key) => {
    if (key.upArrow) onMove(-1);
    else if (key.downArrow) onMove(1);
    else if (key.return) onSelect();
    else if (key.escape) onClose();
  });

  return (
    <Box borderStyle="single" borderTop={true} borderBottom={true} borderLeft={false} borderRight={false} paddingX={1} gap={1}>
      <Text color="yellow" bold>{'rewind'}</Text>
      <Text>
        <Text color="cyan">{selectedIndex + 1}/{candidateCount}</Text>
        {'  '}target message {selectedCandidate ? selectedCandidate.messageIndex + 1 : '?'}
        {'  '}remove {selectedCandidate?.removedCount ?? 0}
        {'  '}<Text dimColor>up/down select  enter confirm  esc cancel</Text>
      </Text>
    </Box>
  );
};

interface AppProps {
  workingDir?: string;
  config?: SquirlConfig;
  onSetup?: () => void;
}

const FIXED_CHROME_ROWS = 9;

export const App: React.FC<AppProps> = ({
  workingDir = process.cwd(),
  config,
  onSetup,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalRows = stdout.rows ?? 24;
  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [inputValue, setInputValue] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isImportPromptOpen, setIsImportPromptOpen] = useState(false);
  const [isRoomRosterOpen, setIsRoomRosterOpen] = useState(false);
  const [isRecipientPickerOpen, setIsRecipientPickerOpen] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState(SQUIRL_PARTICIPANT.id);
  const [isRewindPickerOpen, setIsRewindPickerOpen] = useState(false);
  const [rewindPickerIndex, setRewindPickerIndex] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<{ command: string; resolve: (approved: boolean) => void } | null>(null);
  const [agentInteractions, setAgentInteractions] = useState<Array<{ participantId: string; request: AgentInteractionRequest }>>([]);
  const [pendingRewind, setPendingRewind] = useState<RewindRequest | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState('');
  const [pipelineStatus, setPipelineStatus] = useState<QueryPipelineStatus | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [isToolMode, setIsToolMode] = useState(false);
  const [selectedToolIndex, setSelectedToolIndex] = useState(0);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const streamStartRef = useRef(0);
  const streamTokensRef = useRef(0);
  const latestAssistantRef = useRef<AssistantMessage | null>(null);
  const orchestratorRef = useRef(new Orchestrator(workingDir));
  const statusEmitterRef = useRef(new StatusEmitter());
  const ingestQueueRef = useRef<IngestQueue | null>(null);
  const embedderRef = useRef<ReturnType<typeof createEmbedder> | null>(null);
  const vectorStoreRef = useRef<VectorStore | null>(null);
  const [selectedModel, setSelectedModel] = useState<SelectedModel>(() => defaultModelFromConfig(config));
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [embedderDisplay, setEmbedderDisplay] = useState('');
  const [mouseMode, setMouseMode] = useState(true);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const addToast = useCallback((text: string, type: 'error' | 'info' = 'error') => {
    setToasts((prev) => [...prev, { id: crypto.randomUUID(), text, type }]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScrollRef = useRef(0);
  const prevMaxScrollRef = useRef(0);
  const streamAutoscrollRef = useRef(false);
  const rewindCandidates = buildRewindCandidates(messages);
  const toolMessages = messages.filter((message): message is Extract<Message, { role: 'tool' }> => message.role === 'tool');
  const selectedTool = toolMessages[Math.min(selectedToolIndex, Math.max(0, toolMessages.length - 1))];

  // ---- Multi-agent group chat ----
  const [participants, setParticipants] = useState<Participant[]>([USER_PARTICIPANT, SQUIRL_PARTICIPANT]);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  const participantsRef = useRef<Participant[]>(participants);
  participantsRef.current = participants;
  const agentContentRef = useRef<Map<string, string>>(new Map());
  const agentResponseMetaRef = useRef<Map<string, ResponseMeta | undefined>>(new Map());
  const pendingToolsRef = useRef<Map<string, { messageId: string; input: unknown }>>(new Map());
  const agentFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleAgentEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const runLocalTurnRef = useRef<(input: string, emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>>(async () => {});
  const scheduledTurnRunnerRef = useRef<(turn: ParticipantTurn, context: TurnExecutionContext) => Promise<void>>(async () => {});
  const coordinatorRef = useRef<GroupChatCoordinator | null>(null);
  const configRef = useRef<SquirlConfig>(config ?? {});
  const routingMetaLLMRef = useRef<MetaLLM | null>(null);
  const taskMetaLLMRef = useRef<MetaLLM | null>(null);
  if (!routingMetaLLMRef.current) routingMetaLLMRef.current = createConfiguredMetaLLM(configRef.current);
  const bypassSemanticDelegationRef = useRef<string | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new GroupChatCoordinator({
      config: { autoHandoff: config?.agents?.autoHandoff, maxHops: config?.agents?.maxHops },
      transport: new LocalSpawnTransport(),
      localTurn: (input, emit, signal) => runLocalTurnRef.current(input, emit, signal),
      facilitateTurn: (participantId, output, signal) => orchestratorRef.current.assessFacilitation(
        participantId, output, messagesRef.current, selectedModelRef.current, signal,
      ),
    });
    coordinatorRef.current.onEvent((event) => handleAgentEventRef.current(event));
  }
  const schedulerRef = useRef<ParticipantTurnScheduler | null>(null);
  if (!schedulerRef.current) {
    schedulerRef.current = new ParticipantTurnScheduler(
      (turn, context) => scheduledTurnRunnerRef.current(turn, context),
      (participantId) => participantId === SQUIRL_PARTICIPANT.id || Boolean(coordinatorRef.current?.getDescriptor(participantId)),
      (error, turn) => addToast(`@${turn.participantId} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  const [workState, setWorkState] = useState<ParticipantWorkState>(() => schedulerRef.current!.snapshot());
  useEffect(() => schedulerRef.current!.onChange((work) => {
    setWorkState(work);
    setIsStreaming(work.active.length > 0);
  }), []);

  useEffect(() => {
    if (!participants.some((participant) => participant.id === selectedRecipientId)) setSelectedRecipientId(SQUIRL_PARTICIPANT.id);
  }, [participants, selectedRecipientId]);

  useEffect(() => {
    orchestratorRef.current.setIdentityContext({
      displayName: configRef.current.userProfile?.displayName,
      participants: participants.map(({ id, label, status, specialty }) => ({ id, label, status, specialty })),
    });
  }, [participants]);

  const handleMaxScroll = useCallback((max: number) => {
    const prev = prevMaxScrollRef.current;
    prevMaxScrollRef.current = max;
    maxScrollRef.current = max;

    if (isStreaming && max > prev) {
      setScrollOffset((offset) => nextStreamingScrollOffset({
        prevOffset: offset,
        prevMax: prev,
        nextMax: max,
        autoscroll: streamAutoscrollRef.current,
      }));
    }
  }, [isStreaming]);

  const applyManualScroll = useCallback((delta: number) => {
    setScrollOffset((prev) => {
      const nextOffset = applyScrollDelta(prev, delta, maxScrollRef.current);
      streamAutoscrollRef.current = nextAutoscrollEnabled({
        isStreaming,
        current: streamAutoscrollRef.current,
        delta,
        nextOffset,
      });
      return nextOffset;
    });
  }, [isStreaming]);

  // Surface index status as toasts
  const lastIndexErrorRef = useRef('');
  useEffect(() => {
    const emitter = statusEmitterRef.current;
    const listener = (s: { phase: string; error?: string; batchSize?: number; chars?: number; maxChars?: number }) => {
      if (s.phase === 'error' && s.error && s.error !== lastIndexErrorRef.current) {
        lastIndexErrorRef.current = s.error;
        addToast(s.error);
      }
      if (s.phase === 'embedding' && s.batchSize && s.chars) {
        addToast(`embedding ${s.batchSize} turn(s) — ${s.chars} chars (max ${s.maxChars ?? '?'})`, 'info');
      }
      if (s.phase === 'idle') lastIndexErrorRef.current = '';
    };
    emitter.on(listener as any);
    return () => { emitter.off(listener as any); };
  }, [addToast]);

  useEffect(() => {
    if (mouseMode) {
      enableMouseTracking();
    } else {
      disableMouseTracking();
    }
  }, [mouseMode]);

  useMouseWheel({
    onScroll: applyManualScroll,
    isActive: mouseMode && !isModelMenuOpen && !isContextMenuOpen && !isCommandPaletteOpen && !isRewindPickerOpen && !isRoomRosterOpen,
    linesPerWheel: config?.mouseScrollLines,
  });

  // Detect backend and fetch context window from local provider when not already known
  useEffect(() => {
    if (selectedModel.provider !== 'local' || !selectedModel.baseUrl) return;
    if (selectedModel.backend && selectedModel.contextWindow) return;
    let cancelled = false;
    (async () => {
      const backend = selectedModel.backend ?? await detectLocalBackend(selectedModel.baseUrl!);
      if (cancelled) return;
      const models = await fetchAvailableModels(selectedModel.baseUrl!, backend);
      if (cancelled) return;
      const match = models.find((m) => m.id === selectedModel.id);
      setSelectedModel((prev) => ({
        ...prev,
        backend,
        ...(match?.contextWindow ? { contextWindow: match.contextWindow } : {}),
      }));
      // Persist the discovered window so it survives restarts. Merge into the
      // latest on-disk config to avoid clobbering unrelated fields.
      if (match?.contextWindow) {
        const fresh = loadConfig();
        const next = rememberContextWindow(fresh, selectedModel.id, match.contextWindow);
        if (next !== fresh) saveConfig(next);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedModel.id, selectedModel.provider, selectedModel.baseUrl, selectedModel.backend, selectedModel.contextWindow]);

  useEffect(() => {
    if (isStreaming) return;
    const cfg = getModelConfig(selectedModel.id);
    const sysMsg = buildSystemPrompt(
      {
        workingDir, date: new Date().toISOString().slice(0, 10), modelId: selectedModel.id,
        platform: platform(), shell: process.env.SHELL ?? 'unknown', supportsTools: cfg.supportsTools,
        displayName: configRef.current.userProfile?.displayName,
        participants: participantsRef.current.map(({ id, label, status, specialty }) => ({ id, label, status, specialty })),
      },
      cfg.systemPromptStyle,
    );
    const sysContent = typeof sysMsg.content === 'string' ? sysMsg.content : '';
    let total = estimateTokens(sysContent);
    for (const content of orchestratorRef.current.getContextFiles().values()) {
      total += estimateTokens(content);
    }
    for (const msg of messages) {
      total += estimateTokens(msg.content) + 4;
    }
    setTokenCount(total);
  }, [messages, selectedModel.id, workingDir, isStreaming]);

  useEffect(() => {
    if (!config?.index?.enabled) return;
    let cancelled = false;
    taskMetaLLMRef.current = null;

    (async () => {
      const storeConfig = {
        type: config.index!.store,
        chromaUrl: config.index!.chromaUrl,
        chromaAuthToken: config.index!.chromaAuthToken,
        collection: config.index!.collection,
      } as const;

      try {
        const rawEmbedderUrl = config.index!.embedderUrl ?? (config.index as any).ollamaUrl;
        const embedderUrl = rawEmbedderUrl?.endsWith('/v1') ? rawEmbedderUrl : rawEmbedderUrl ? rawEmbedderUrl.replace(/\/+$/, '') + '/v1' : undefined;
        const embedderBackend = embedderUrl ? await detectLocalBackend(embedderUrl) : undefined;
        if (cancelled) return;

        // Auto-detect embedding model and context window from the server
        let embedderModel = config.index!.embedderModel;
        let embedderMaxTokens = 512;
        if (embedderUrl && embedderBackend) {
          const models = await fetchAvailableModels(embedderUrl, embedderBackend);
          if (cancelled) return;
          if (models.length > 0) {
            if (!embedderModel) embedderModel = models[0]!.id;
            const match = models.find((m) => m.id === embedderModel);
            if (match?.contextWindow) embedderMaxTokens = match.contextWindow;
          }
        }

        const backendLabel = embedderBackend ? BACKEND_DISPLAY_NAMES[embedderBackend] || embedderBackend : '';
        if (config.index!.embedder === 'local' && embedderModel) {
          setEmbedderDisplay(`${embedderModel}${backendLabel ? ` (${backendLabel})` : ''}`);
        } else if (config.index!.embedder === 'openai') {
          setEmbedderDisplay(`openai / ${embedderModel ?? 'text-embedding-3-small'}`);
        }

        const embedder = createEmbedder({
          type: config.index!.embedder,
          apiKey: config.openaiApiKey,
          model: embedderModel,
          baseUrl: embedderUrl,
          detectedBackend: embedderBackend,
        });
        const store = await createVectorStore(storeConfig);

        if (cancelled) { await store.close(); return; }

        embedderRef.current = embedder;
        vectorStoreRef.current = store;

        const queue = new IngestQueue(embedder, store, statusEmitterRef.current, embedderMaxTokens);
        ingestQueueRef.current = queue;

        // Memory retrieval pipeline
        const metaProvider = config.index!.metaProvider ?? config.defaultProvider ?? 'openai';
        const metaModel = config.index!.metaModel ?? (metaProvider === 'local' ? (config.defaultModel ?? 'default') : 'gpt-4o-mini');
        let metaLLM: MetaLLM;
        if (metaProvider === 'anthropic') {
          metaLLM = new AnthropicMetaLLM({ model: metaModel });
        } else {
          metaLLM = new OpenAIMetaLLM({
            model: metaModel,
            ...(metaProvider === 'local' ? { baseUrl: config.localBaseUrl } : {}),
          });
        }

        const memoryPipeline = new MemoryPipeline(metaLLM, embedder, store, {
          recallK: config.index!.recallK ?? 10,
        });
        taskMetaLLMRef.current = metaLLM;
        orchestratorRef.current.setMemoryPipeline(memoryPipeline);

        const files = getAllHistoryFiles();
        const allEntries = files.flatMap((f) => readEntries(f));
        await backfillFromHistory(queue, store, allEntries);
      } catch (err) {
        if (cancelled) return;
        const message = formatVectorStoreStartupError(err, storeConfig);
        taskMetaLLMRef.current = null;
        embedderRef.current = null;
        vectorStoreRef.current = null;
        ingestQueueRef.current = null;
        orchestratorRef.current.setMemoryPipeline(null);
        statusEmitterRef.current.update({ phase: 'error', pending: 0, error: message });
      }
    })();

    return () => {
      cancelled = true;
      taskMetaLLMRef.current = null;
      orchestratorRef.current.setMemoryPipeline(null);
    };
  }, [config?.index?.enabled]);

  const handleInputChange = useCallback((v: string) => {
    setInputValue(v);
    setCommandIndex(0);
  }, []);

  useInput((input, key) => {
    if (isModelMenuOpen || isContextMenuOpen || isCommandPaletteOpen || isImportPromptOpen || isRewindPickerOpen || isRoomRosterOpen || isRecipientPickerOpen || pendingRewind) return;
    if (key.ctrl && input === 'c') { exit(); return; }
    if (isToolMode) {
      if (key.escape || (key.ctrl && input === 't')) { setIsToolMode(false); return; }
      if (key.upArrow) { setSelectedToolIndex((index) => Math.max(0, index - 1)); return; }
      if (key.downArrow) { setSelectedToolIndex((index) => Math.min(Math.max(0, toolMessages.length - 1), index + 1)); return; }
      if (key.return && selectedTool) {
        setExpandedToolIds((previous) => {
          const next = new Set(previous);
          if (next.has(selectedTool.id)) next.delete(selectedTool.id); else next.add(selectedTool.id);
          return next;
        });
        return;
      }
      return;
    }
    if (key.ctrl && input === 'p') { if (!isStreaming) setIsCommandPaletteOpen(true); return; }
    if (key.ctrl && input === 'r') { setIsRoomRosterOpen(true); return; }
    if (key.ctrl && input === 'v') { setShowThinking((v) => !v); return; }
    if (key.ctrl && input === 's') { setMouseMode((v) => !v); return; }
    if (key.ctrl && input === 'x') {
      const queued = workState.queued.find((turn) => turn.participantId === selectedRecipientId);
      if (queued) schedulerRef.current?.removeQueued(queued.id);
      return;
    }
    if (key.ctrl && input === 't') {
      if (toolMessages.length > 0) { setSelectedToolIndex(toolMessages.length - 1); setIsToolMode(true); }
      return;
    }
    if (key.tab && !inputValue.startsWith('/')) { setIsRecipientPickerOpen(true); return; }
    // Shift+Up/Down to scroll message history
    if (key.shift && key.upArrow) { applyManualScroll(3); return; }
    if (key.shift && key.downArrow) { applyManualScroll(-3); return; }
    // Slash command navigation
    if (inputValue.startsWith('/') && (key.upArrow || key.downArrow || key.tab)) {
      const matches = filterCommands(inputValue.slice(1));
      if (matches.length === 0) return;
      if (key.tab) {
        setInputValue('/' + matches[commandIndex]!.name);
        setCommandIndex(0);
      } else if (key.upArrow) {
        setCommandIndex(Math.max(0, commandIndex - 1));
      } else {
        setCommandIndex(Math.min(matches.length - 1, commandIndex + 1));
      }
      return;
    }

    if (key.upArrow || key.downArrow) {
      const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
      if (userMessages.length === 0) return;

      if (key.upArrow) {
        if (historyIndexRef.current === -1) {
          savedInputRef.current = inputValue;
        }
        const next = Math.min(historyIndexRef.current + 1, userMessages.length - 1);
        historyIndexRef.current = next;
        setInputValue(userMessages[userMessages.length - 1 - next]!);
      } else {
        const next = historyIndexRef.current - 1;
        if (next < 0) {
          historyIndexRef.current = -1;
          setInputValue(savedInputRef.current);
        } else {
          historyIndexRef.current = next;
          setInputValue(userMessages[userMessages.length - 1 - next]!);
        }
      }
      return;
    }
    if (key.escape) {
      if (schedulerRef.current?.cancel(selectedRecipientId)) {
        if (selectedRecipientId !== SQUIRL_PARTICIPANT.id) void coordinatorRef.current?.interrupt(selectedRecipientId);
      } else {
        setInputValue('');
      }
    }
  });

  const handleModelSelect = (model: SelectedModel) => {
    setSelectedModel(model);
    setIsModelMenuOpen(false);
  };

  const handlePaletteSelect = (action: PaletteAction) => {
    setIsCommandPaletteOpen(false);
    if (action === 'model') {
      setIsModelMenuOpen(true);
    } else if (action === 'import-chatgpt') {
      setIsImportPromptOpen(true);
    }
  };

  const handleImportSubmit = async (path: string) => {
    setIsImportPromptOpen(false);
    if (!path.trim()) return;
    const resolved = path.trim().replace(/\\ /g, ' ').replace(/^~/, process.env.HOME ?? '');
    try {
      const { ChatGPTImporter } = await import('./search/importers/chatgpt.js');
      const { appendImportMessage } = await import('./history.js');
      const importer = new ChatGPTImporter();
      let count = 0;
      for await (const pair of importer.parse(resolved)) {
        if (pair.userText) appendImportMessage({ id: crypto.randomUUID(), role: 'user', content: pair.userText }, 'chatgpt', pair.timestamp);
        if (pair.assistantText) appendImportMessage({ id: crypto.randomUUID(), role: 'assistant', content: pair.assistantText }, 'chatgpt', pair.timestamp);
        count++;
      }
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'tool' as const,
        toolCallId: 'import',
        toolName: '/import',
        content: `Imported ${count} conversation turns from ChatGPT.`,
      }]);
    } catch (err: unknown) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'tool' as const,
        toolCallId: 'import',
        toolName: '/import',
        content: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    }
  };

  const openRewindPicker = useCallback(() => {
    if (isStreaming) {
      addToast('Cannot rewind while streaming.');
      return;
    }
    const candidates = buildRewindCandidates(messages);
    if (candidates.length === 0) {
      addToast('No previous user messages to rewind to.');
      return;
    }
    setRewindPickerIndex(candidates.length - 1);
    setIsRewindPickerOpen(true);
    setScrollOffset(0);
  }, [addToast, isStreaming, messages]);

  const moveRewindPicker = useCallback((direction: -1 | 1) => {
    setRewindPickerIndex((index) => Math.max(0, Math.min(rewindCandidates.length - 1, index + direction)));
  }, [rewindCandidates.length]);

  const selectRewindCandidate = useCallback(() => {
    const candidate = rewindCandidates[rewindPickerIndex];
    if (!candidate) {
      setIsRewindPickerOpen(false);
      setScrollOffset(0);
      addToast('No rewind target selected.');
      return;
    }
    setIsRewindPickerOpen(false);
    setScrollOffset(0);
    setPendingRewind(rewindRequestFromCandidate(candidate));
  }, [addToast, rewindCandidates, rewindPickerIndex]);

  const performRewind = useCallback(async (request: RewindRequest) => {
    if (isStreaming) {
      addToast('Cannot rewind while streaming.');
      return;
    }

    const visibleRetained = messages.slice(0, request.retainedCount);
    const visibleRemoved = messages.slice(request.retainedCount);
    const writableIds = new Set(
      getAllHistoryFiles().flatMap((file) => readEntries(file).map((entry) => entry.message.id)),
    );
    const persistedIds = new Set(loadHistory().map((message) => message.id));

    if (request.targetMessageId !== null && !writableIds.has(request.targetMessageId)) {
      addToast('Cannot rewind to imported history; choose a Squirl message.');
      return;
    }
    const nonWritableRemoved = visibleRemoved.filter((message) => !writableIds.has(message.id) && persistedIds.has(message.id));
    if (nonWritableRemoved.length > 0) {
      addToast('Cannot rewind across imported history; imported archives are preserved.');
      return;
    }

    const oldPairIds = new Set(messagesToTurnPairs(messages, 'current', 'squirl').map((pair) => pair.id));
    const retainedPairIds = new Set(messagesToTurnPairs(visibleRetained, 'current', 'squirl').map((pair) => pair.id));
    const deleteIds = [...oldPairIds].filter((id) => !retainedPairIds.has(id));

    const result = rewindHistoryAfter(request.targetMessageId);
    if (!result.targetFound) {
      addToast('Cannot rewind: target message is not in writable Squirl history.');
      return;
    }

    setMessages(() => visibleRetained);
    setScrollOffset(0);
    historyIndexRef.current = -1;
    savedInputRef.current = '';

    if (deleteIds.length > 0 && vectorStoreRef.current) {
      try {
        await vectorStoreRef.current.delete(deleteIds);
      } catch (err) {
        addToast(`Rewound history, but recall cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    addToast(`Rewound ${visibleRemoved.length} message${visibleRemoved.length === 1 ? '' : 's'}.`, 'info');
  }, [addToast, isStreaming, messages]);

  const flushAgentContent = useCallback(() => {
    if (agentFlushRef.current) return;
    agentFlushRef.current = setTimeout(() => {
      agentFlushRef.current = null;
      const snapshot = agentContentRef.current;
      if (snapshot.size === 0) return;
      setMessages((prev) => prev.map((m) => (snapshot.has(m.id) ? { ...m, content: snapshot.get(m.id)! } : m)));
    }, 33);
  }, []);

  const participantLabel = useCallback((id: string) => participantsRef.current.find((p) => p.id === id)?.label ?? id, []);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    const pid = event.participantId === SQUIRL_PARTICIPANT.id ? undefined : event.participantId;
    switch (event.type) {
      case 'message-start': {
        agentContentRef.current.set(event.messageId, '');
        agentResponseMetaRef.current.set(event.messageId, event.responseMeta);
        setMessages((prev) => [...prev, { id: event.messageId, role: 'assistant', content: '', isStreaming: true, participantId: pid, responseMeta: event.responseMeta }]);
        break;
      }
      case 'token': {
        agentContentRef.current.set(event.messageId, (agentContentRef.current.get(event.messageId) ?? '') + event.token);
        flushAgentContent();
        break;
      }
      case 'message-end': {
        agentContentRef.current.delete(event.messageId);
        const finalized: AssistantMessage = { id: event.messageId, role: 'assistant', content: event.content, isStreaming: false, participantId: pid, responseMeta: agentResponseMetaRef.current.get(event.messageId) };
        agentResponseMetaRef.current.delete(event.messageId);
        setMessages((prev) => prev.map((m) => (m.id === event.messageId ? finalized : m)));
        appendMessage(finalized);
        break;
      }
      case 'tool-start': {
        schedulerRef.current?.setPhase(event.participantId, 'tool', event.toolName);
        setToolStatus(`${participantLabel(event.participantId)}: ${event.toolName}`);
        const key = event.toolId || `${event.participantId}:${event.toolName}`;
        const messageId = crypto.randomUUID();
        pendingToolsRef.current.set(key, { messageId, input: event.input });
        setMessages((prev) => [...prev, {
          id: messageId, role: 'tool', toolCallId: event.toolId || key,
          toolName: `${participantLabel(event.participantId)}:${event.toolName}`,
          content: '', toolInput: event.input, toolStatus: 'running', participantId: event.participantId,
        }]);
        break;
      }
      case 'tool-end': {
        schedulerRef.current?.setPhase(event.participantId, 'working');
        setToolStatus('');
        const key = event.toolId || `${event.participantId}:${event.toolName}`;
        const pending = pendingToolsRef.current.get(key);
        pendingToolsRef.current.delete(key);
        const bounded = boundedToolOutput(event.result);
        const toolMsg: Message = {
          id: pending?.messageId ?? crypto.randomUUID(), role: 'tool',
          toolCallId: event.toolId || crypto.randomUUID(),
          toolName: `${participantLabel(event.participantId)}:${event.toolName}`,
          content: bounded.content || (event.ok ? '(ok)' : '(failed)'),
          toolInput: pending?.input,
          toolStatus: event.ok ? 'success' : 'error',
          outputTruncated: bounded.truncated || undefined,
          participantId: event.participantId,
        };
        setMessages((prev) => pending
          ? prev.map((message) => message.id === pending.messageId ? toolMsg : message)
          : [...prev, toolMsg]);
        appendMessage(toolMsg);
        break;
      }
      case 'session-status': {
        setParticipants((prev) => prev.map((p) => (p.id === event.participantId ? { ...p, status: event.status } : p)));
        break;
      }
      case 'interaction-request': {
        setAgentInteractions((current) => [...current, { participantId: event.participantId, request: event.request }]);
        break;
      }
      case 'interaction-notify': {
        addToast(`${participantLabel(event.participantId)}: ${event.message}`);
        break;
      }
      case 'interaction-status': {
        schedulerRef.current?.setPhase(event.participantId, event.text ? 'tool' : 'working', event.text);
        setToolStatus(event.text ? `${participantLabel(event.participantId)}: ${event.text}` : '');
        break;
      }
      case 'interaction-editor-prefill': {
        setSelectedRecipientId(event.participantId);
        setInputValue(event.text);
        break;
      }
      case 'error': {
        addToast(`${participantLabel(event.participantId)}: ${event.message}`);
        break;
      }
      default:
        break;
    }
  }, [addToast, flushAgentContent, participantLabel]);
  handleAgentEventRef.current = handleAgentEvent;

  const runLocalTurn = useCallback((input: string, emit: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> => {
    let assistantId = '';
    let lastContent = '';
    return orchestratorRef.current.chat(input, messagesRef.current, selectedModel, {
      onNewMessage: (msg) => {
        if (msg.role === 'assistant') { assistantId = msg.id; emit({ type: 'message-start', participantId: SQUIRL_PARTICIPANT.id, messageId: msg.id, responseMeta: { model: selectedModel.id } }); }
        else if (msg.role === 'tool') { emit({ type: 'tool-end', participantId: SQUIRL_PARTICIPANT.id, toolId: msg.toolCallId, toolName: msg.toolName, result: msg.content, ok: true }); }
      },
      onToken: (token, assistant) => { assistantId = assistant.id; lastContent = assistant.content; emit({ type: 'token', participantId: SQUIRL_PARTICIPANT.id, messageId: assistant.id, token }); },
      onDone: () => { if (assistantId) emit({ type: 'message-end', participantId: SQUIRL_PARTICIPANT.id, messageId: assistantId, content: lastContent }); emit({ type: 'turn-end', participantId: SQUIRL_PARTICIPANT.id }); },
      onError: (err) => { emit({ type: 'error', participantId: SQUIRL_PARTICIPANT.id, message: err.message }); emit({ type: 'turn-end', participantId: SQUIRL_PARTICIPANT.id }); },
      onToolApproval: (_name, args) => new Promise<boolean>((resolve) => setPendingApproval({ command: String(args.command ?? ''), resolve })),
      onToolStart: (name) => emit({ type: 'tool-start', participantId: SQUIRL_PARTICIPANT.id, toolId: '', toolName: name, input: {} }),
    }, signal).then(() => undefined);
  }, [selectedModel]);
  runLocalTurnRef.current = runLocalTurn;

  const addAgentCmd = useCallback(async (kind: AgentKind, opts?: { id?: string; model?: string; effort?: import('./types.js').EffortLevel }) => {
    try {
      const existingIds = coordinatorRef.current!.listParticipants().map((participant) => participant.id);
      const id = opts?.id ? validateAgentHandle(opts.id, existingIds) : nextAvailableAgentId(kind, existingIds);
      const codexDefaults = kind === 'codex' ? discoverCodexModels() : undefined;
      const descriptor = buildAgentDescriptor({
        kind, cwd: workingDir, id, label: id, model: opts?.model ?? codexDefaults?.defaultModel, effort: opts?.effort,
        bin: kind === 'claude-code' ? configRef.current.agents?.claudeBin : kind === 'codex' ? resolveCodexBinary(configRef.current.agents?.codexBin) : resolvePiBinary(configRef.current.agents?.piBin),
        permissionMode: configRef.current.agents?.defaultClaudePermissionMode ?? 'acceptEdits',
        sandbox: configRef.current.agents?.defaultCodexSandbox ?? 'workspace-write',
        approvalPolicy: configRef.current.agents?.defaultCodexApprovalPolicy ?? 'on-request',
        piToolMode: configRef.current.agents?.defaultPiToolMode,
        piApprovalMode: configRef.current.agents?.defaultPiApprovalMode ?? 'acceptEdits',
      });
      const participant = await coordinatorRef.current!.addAgent(descriptor);
      setParticipants(coordinatorRef.current!.listParticipants());
      configRef.current = upsertAgentProfile(configRef.current, profileFromDescriptor(descriptor));
      saveConfig(configRef.current);
      return { ok: true as const, id: participant.id, label: participant.label };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [workingDir]);

  const stopAgentCmd = useCallback(async (id: string) => {
    if (!coordinatorRef.current!.hasAgent(id)) return false;
    await coordinatorRef.current!.removeAgent(id);
    setParticipants(coordinatorRef.current!.listParticipants());
    setAgentInteractions((items) => items.filter((item) => item.participantId !== id));
    configRef.current = removeAgentProfile(configRef.current, id);
    saveConfig(configRef.current);
    return true;
  }, []);

  const renameAgentCmd = useCallback(async (id: string, name: string) => {
    try {
      const nextId = validateAgentHandle(name, coordinatorRef.current!.listParticipants().map((participant) => participant.id), id);
      const descriptor = coordinatorRef.current!.getDescriptor(id);
      if (!descriptor) throw new Error(`No agent "@${id}".`);
      const profile = configRef.current.agents?.defaults?.find((item) => item.id?.toLowerCase() === id.toLowerCase());
      const participant = await coordinatorRef.current!.renameAgent(id, nextId, nextId);
      configRef.current = removeAgentProfile(configRef.current, id);
      configRef.current = upsertAgentProfile(configRef.current, profileFromDescriptor({ ...descriptor, id: nextId, label: nextId }, profile?.profileId));
      saveConfig(configRef.current);
      setParticipants(coordinatorRef.current!.listParticipants());
      if (selectedRecipientId === id) setSelectedRecipientId(nextId);
      return { ok: true as const, id: participant.id, label: participant.label };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [selectedRecipientId]);

  const listAgentsCmd = useCallback(() => coordinatorRef.current!.listParticipants()
    .filter((p) => p.kind !== 'user' && p.kind !== 'local-llm')
    .map((p) => ({ id: p.id, label: p.label, status: p.status ?? '?', mode: p.mode ?? '' })), []);

  const executeAgentDispatch = useCallback(async (participantId: string, value: string, context: TurnExecutionContext) => {
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value, participantId };
    setMessages((prev) => [...prev, userMsg]);
    appendMessage(userMsg);
    streamAutoscrollRef.current = true;
    setScrollOffset(0);
    context.setPhase('working');
    await coordinatorRef.current!.dispatchTo(participantId, value, context.signal);
  }, []);

  const runAgentDispatch = useCallback((value: string) => {
    schedulerRef.current!.enqueue(selectedRecipientId, value);
    setInputValue('');
    historyIndexRef.current = -1;
    savedInputRef.current = '';
  }, [selectedRecipientId]);

  const executeDelegatedDispatch = useCallback(async (value: string, delegation: DelegationIntent, context: TurnExecutionContext) => {
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value, participantId: SQUIRL_PARTICIPANT.id };
    const handoffHistory = [...messagesRef.current, userMsg];
    setMessages((prev) => [...prev, userMsg]);
    appendMessage(userMsg);
    streamAutoscrollRef.current = true;
    setScrollOffset(0);
    for (const id of delegation.unavailableTargetIds) addToast(`Agent @${id} is not connected. Open Agents and connect it before delegating work.`);
    await Promise.all(delegation.targetIds.map(async (targetId) => {
        if (context.signal.aborted) return;
        const participant = coordinatorRef.current!.listParticipants().find((item) => item.id === targetId);
        if (!participant) return;
        const handoff = await orchestratorRef.current.prepareHandoff(
          { id: participant.id, label: participant.label, specialty: participant.specialty },
          delegation.originalRequest,
          delegation.task,
          handoffHistory,
          selectedModelRef.current,
          context.signal,
          (stage) => { setPipelineStatus({ stage }); context.setPhase('preparing', stage); },
        );
        const messageId = crypto.randomUUID();
        handleAgentEventRef.current({ type: 'message-start', participantId: SQUIRL_PARTICIPANT.id, messageId, responseMeta: { model: selectedModelRef.current.id } });
        handleAgentEventRef.current({ type: 'token', participantId: SQUIRL_PARTICIPANT.id, messageId, token: handoff });
        handleAgentEventRef.current({ type: 'message-end', participantId: SQUIRL_PARTICIPANT.id, messageId, content: handoff });
        schedulerRef.current!.enqueue(targetId, handoff, { delegated: true });
    }));
    setPipelineStatus(null);
  }, [addToast]);

  const runDelegatedDispatch = useCallback((value: string, delegation: DelegationIntent) => {
    schedulerRef.current!.enqueue(SQUIRL_PARTICIPANT.id, value, { kind: 'delegation', delegation });
    setInputValue('');
    historyIndexRef.current = -1;
    savedInputRef.current = '';
  }, []);

  // Auto-start agents configured to launch on startup.
  useEffect(() => {
    const defaults = configRef.current.agents?.defaults;
    if (!defaults?.length) return;
    (async () => {
      const migrated = [];
      for (const raw of defaults) {
        try {
          const profile = materializeProfile(raw, workingDir);
          if (!profile.reconnect) { migrated.push(profile); continue; }
          const codexDefaults = profile.kind === 'codex' ? discoverCodexModels() : undefined;
          const descriptor = buildAgentDescriptor({
            kind: profile.kind, cwd: profile.cwd, id: profile.id, label: profile.label, specialty: profile.specialty,
            model: profile.model ?? codexDefaults?.defaultModel, effort: profile.effort,
            bin: profile.bin ?? (profile.kind === 'claude-code' ? configRef.current.agents?.claudeBin : profile.kind === 'codex' ? resolveCodexBinary(configRef.current.agents?.codexBin) : resolvePiBinary(configRef.current.agents?.piBin)),
            permissionMode: profile.permissionMode ?? configRef.current.agents?.defaultClaudePermissionMode ?? 'acceptEdits',
            sandbox: profile.sandbox ?? configRef.current.agents?.defaultCodexSandbox ?? 'workspace-write',
            approvalPolicy: profile.approvalPolicy ?? configRef.current.agents?.defaultCodexApprovalPolicy ?? 'on-request',
            piToolMode: profile.piToolMode ?? configRef.current.agents?.defaultPiToolMode,
            piApprovalMode: profile.piApprovalMode ?? configRef.current.agents?.defaultPiApprovalMode ?? 'acceptEdits',
          });
          await coordinatorRef.current!.addAgent(descriptor);
          migrated.push(profileFromDescriptor(descriptor, profile.profileId));
        } catch (err) { addToast(`Could not reconnect agent: ${err instanceof Error ? err.message : String(err)}`); }
      }
      configRef.current = { ...configRef.current, agents: { ...configRef.current.agents, defaults: migrated } };
      saveConfig(configRef.current);
      setParticipants(coordinatorRef.current!.listParticipants());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateScrum = async (dateInput: string): Promise<string> => {
    const llm = taskMetaLLMRef.current;
    const embedder = embedderRef.current;
    const vectorStore = vectorStoreRef.current;
    if (!configRef.current.index?.enabled || !llm || !embedder || !vectorStore) {
      throw new Error('Scrum reports require semantic memory. Run /setup to configure the task index.');
    }
    const now = new Date();
    const cutoff = now.getTime() - TASK_ACTIVITY_WINDOW_MS;
    const currentTasks = (loadTaskActivitySnapshot()?.tasks ?? []).filter((task) =>
      task.source !== 'calendar' && Date.parse(task.lastActiveAt) >= cutoff,
    );
    return formatScrumReport(await generateScrumReport({
      input: dateInput,
      entries: loadAllHistoryEntries(),
      currentTasks,
      llm,
      embedder,
      vectorStore,
      now,
      recallK: configRef.current.index.recallK ?? 8,
    }));
  };

  const executeSquirlTurn = useCallback(async (value: string, context: TurnExecutionContext) => {
    streamAutoscrollRef.current = true;
    setScrollOffset(0);
    setTokensPerSecond(0);
    streamStartRef.current = Date.now();
    streamTokensRef.current = 0;
    latestAssistantRef.current = null;
    let assistantId = '';
    const priorMessages = messagesRef.current.filter((message) =>
      !(message.role === 'assistant' && message.isStreaming)
      && !(message.role === 'tool' && message.toolStatus === 'running'));

    try {
      const newMessages = await orchestratorRef.current.chat(
        value,
        priorMessages,
        selectedModelRef.current,
        {
          onNewMessage: (message) => {
            if (message.role === 'user') message = { ...message, participantId: SQUIRL_PARTICIPANT.id };
            if (message.role === 'assistant') {
              message = { ...message, responseMeta: { model: selectedModelRef.current.id } };
              assistantId = message.id;
              latestAssistantRef.current = message;
            }
            setMessages((previous) => [...previous, message]);
            if (message.role !== 'assistant') appendMessage(message);
          },
          onToken: (token, assistant) => {
            latestAssistantRef.current = assistant;
            if (token) streamTokensRef.current++;
            const elapsed = (Date.now() - streamStartRef.current) / 1000;
            if (elapsed > 0.5) setTokensPerSecond(Math.round(streamTokensRef.current / elapsed));
            setMessages((previous) => previous.map((message) => message.id === assistant.id && message.role === 'assistant'
              ? { ...message, ...assistant, responseMeta: message.responseMeta }
              : message));
          },
          onDone: () => {
            const latest = latestAssistantRef.current;
            setMessages((previous) => previous.map((message) => {
              if (message.id !== assistantId || message.role !== 'assistant') return message;
              const finalized = { ...message, ...(latest?.id === assistantId ? latest : {}), isStreaming: false } as AssistantMessage;
              appendMessage(finalized);
              return finalized;
            }));
          },
          onError: (error) => {
            setMessages((previous) => previous.map((message) => message.id === assistantId && message.role === 'assistant'
              ? { ...message, content: `Error: ${error.message}`, isStreaming: false }
              : message));
          },
          onToolApproval: (_toolName, args) => new Promise<boolean>((resolve) => {
            setPendingApproval({ command: args.command as string, resolve });
          }),
          onToolStart: (name) => { setToolStatus(`Running ${name}...`); context.setPhase('tool', name); },
          onToolEnd: () => { setToolStatus(''); context.setPhase('working'); },
          onMemoryStart: () => setToolStatus('Recalling...'),
          onMemoryEnd: (inlineDisplay, queries) => {
            setToolStatus('');
            if (inlineDisplay) setMessages((previous) => [...previous, {
              id: crypto.randomUUID(), role: 'tool', toolCallId: 'memory', toolName: '/memory', content: inlineDisplay,
              memoryLookup: { queries: queries ?? [] },
            }]);
          },
          onStatus: (stage, detail) => {
            setPipelineStatus({ stage, detail });
            context.setPhase(stage === 'tool' ? 'tool' : stage === 'context' || stage.startsWith('memory') ? 'preparing' : 'working', detail ?? stage);
          },
        },
        context.signal,
      );
      if (ingestQueueRef.current && configRef.current.index?.enabled) {
        for (const pair of messagesToTurnPairs(newMessages, 'current', 'squirl')) ingestQueueRef.current.enqueue(pair);
      }
    } finally {
      streamAutoscrollRef.current = false;
      setToolStatus('');
      setPipelineStatus(null);
    }
  }, []);

  scheduledTurnRunnerRef.current = async (turn, context) => {
    const metadata = turn.metadata as { kind?: string; delegation?: DelegationIntent } | undefined;
    if (metadata?.kind === 'delegation' && metadata.delegation) {
      await executeDelegatedDispatch(turn.input, metadata.delegation, context);
    } else if (turn.participantId === SQUIRL_PARTICIPANT.id) {
      await executeSquirlTurn(turn.input, context);
    } else {
      await executeAgentDispatch(turn.participantId, turn.input, context);
    }
  };

  const handleSubmit = (value: string) => {
    if (!value.trim()) return;

    // If in slash command mode, use the selected command from the list
    let cmd = matchCommand(value);
    if (value.startsWith('/') && !cmd) {
      const matches = filterCommands(value.slice(1));
      if (matches[commandIndex]) {
        cmd = matches[commandIndex]!;
      }
    }
    if (cmd) {
      setInputValue('');
      historyIndexRef.current = -1;
      cmd.execute({
        orchestrator: orchestratorRef.current,
        messages,
        workingDir,
        modelId: selectedModel.id,
        setMessages,
        openContextPicker: () => setIsContextMenuOpen(true),
        openModelPicker: () => setIsModelMenuOpen(true),
        openSetup: onSetup,
        embedder: embedderRef.current ?? undefined,
        vectorStore: vectorStoreRef.current ?? undefined,
        indexEnabled: config?.index?.enabled ?? false,
        recallQuery: value.trim().startsWith('/recall ') ? value.trim().slice(8).trim() : '',
        commandInput: value.trim(),
        requestRewind: (request) => setPendingRewind(request),
        openRewindPicker,
        openRoomRoster: () => setIsRoomRosterOpen(true),
        addAgent: addAgentCmd,
        stopAgent: stopAgentCmd,
        renameAgent: renameAgentCmd,
        listAgents: listAgentsCmd,
        displayName: configRef.current.userProfile?.displayName,
        participants,
        generateScrum,
      });
      return;
    }

    if (selectedRecipientId === SQUIRL_PARTICIPANT.id && bypassSemanticDelegationRef.current !== value.trim()) {
      const delegationAgents = new Map<string, DelegationAgent>();
      for (const profile of configRef.current.agents?.defaults ?? []) {
        if (!profile.id) continue;
        delegationAgents.set(profile.id, { id: profile.id, label: profile.label, kind: profile.kind, connected: coordinatorRef.current!.hasAgent(profile.id) });
      }
      for (const participant of coordinatorRef.current!.listParticipants()) {
        if (participant.kind !== 'claude-code' && participant.kind !== 'codex' && participant.kind !== 'pi') continue;
        delegationAgents.set(participant.id, { id: participant.id, label: participant.label, kind: participant.kind, connected: coordinatorRef.current!.hasAgent(participant.id) });
      }
      const knownAgents = [...delegationAgents.values()];
      const pending = recoverPendingDelegation(messagesRef.current);
      const response = pending ? delegationConfirmationResponse(value) : 'unrelated';
      if (pending && response === 'confirm') {
        const targets = pending.targetIds.map((id) => knownAgents.find((agent) => agent.id === id)!).filter(Boolean);
        runDelegatedDispatch(value.trim(), {
          targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
          unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
          originalRequest: pending.originalRequest,
          task: pending.task,
          trigger: 'natural-language',
        });
        return;
      }
      if (pending && response === 'cancel') {
        const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value.trim(), participantId: SQUIRL_PARTICIPANT.id };
        const assistant: AssistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: 'Okay, I won’t dispatch that work.', createdAt: new Date().toISOString() };
        setMessages((current) => [...current, userMsg, assistant]);
        appendMessage(userMsg);
        appendMessage(assistant);
        setInputValue('');
        return;
      }

      void resolveDelegationIntent(value.trim(), knownAgents, routingMetaLLMRef.current).then((resolution) => {
        if (resolution.kind === 'dispatch') {
          runDelegatedDispatch(value.trim(), resolution.delegation);
          return;
        }
        if (resolution.kind === 'confirm') {
          const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value.trim(), participantId: SQUIRL_PARTICIPANT.id };
          const assistant: AssistantMessage = {
            id: crypto.randomUUID(), role: 'assistant', content: delegationConfirmationText(resolution.pending),
            proactiveKind: 'delegation-confirmation', delegationConfirmation: resolution.pending,
            createdAt: new Date().toISOString(),
          };
          setMessages((current) => [...current, userMsg, assistant]);
          appendMessage(userMsg);
          appendMessage(assistant);
          setInputValue('');
          return;
        }
        bypassSemanticDelegationRef.current = value.trim();
        handleSubmit(value.trim());
      }).catch((error) => addToast(error instanceof Error ? error.message : String(error)));
      return;
    }

    if (bypassSemanticDelegationRef.current === value.trim()) bypassSemanticDelegationRef.current = null;

    if (selectedRecipientId !== SQUIRL_PARTICIPANT.id) {
      runAgentDispatch(value.trim());
      return;
    }

    schedulerRef.current!.enqueue(SQUIRL_PARTICIPANT.id, value.trim());
    setInputValue('');
    historyIndexRef.current = -1;
    savedInputRef.current = '';
    return;

  };

  const commandQuery = inputValue.startsWith('/') ? inputValue.slice(1).toLowerCase() : null;

  const modelDisplay = selectedModel.provider === 'local'
    ? selectedModel.backend && selectedModel.backend !== 'unknown'
      ? `${selectedModel.id} (${BACKEND_DISPLAY_NAMES[selectedModel.backend]})`
      : selectedModel.id
    : selectedModel.label;
  const contextWindow = resolveContextWindow(selectedModel, config ?? {});
  const selectedRewindCandidate = rewindCandidates[Math.min(rewindPickerIndex, Math.max(0, rewindCandidates.length - 1))];
  const rewindCandidateIds = new Set(rewindCandidates.map((candidate) => candidate.message.id));
  const messageListHeight = Math.max(1, terminalRows - FIXED_CHROME_ROWS);

  return (
    <Box flexDirection="column" height={terminalRows}>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <Header participants={participants} />
      {isRoomRosterOpen ? (
        <RoomRoster participants={participants} onClose={() => setIsRoomRosterOpen(false)} />
      ) : isRecipientPickerOpen ? (
        <RecipientPicker
          participants={participants}
          selectedId={selectedRecipientId}
          onSelect={(id) => { setSelectedRecipientId(id); setIsRecipientPickerOpen(false); }}
          onClose={() => setIsRecipientPickerOpen(false)}
        />
      ) : isContextMenuOpen ? (
        <ContextPicker
          orchestrator={orchestratorRef.current}
          workingDir={workingDir}
          messages={messages}
          contextWindow={contextWindow ?? getModelConfig(selectedModel.id).contextWindow}
          modelId={selectedModel.id}
          onClose={() => setIsContextMenuOpen(false)}
        />
      ) : isModelMenuOpen ? (
        <ModelPicker
          currentModelId={selectedModel.id}
          onSelect={handleModelSelect}
          onClose={() => setIsModelMenuOpen(false)}
          defaultLocalUrl={config?.localBaseUrl}
        />
      ) : (
        <>
          <MessageList
            messages={messages}
            participants={participants}
            height={messageListHeight}
            showThinking={showThinking}
            scrollOffset={scrollOffset}
            onMaxScroll={handleMaxScroll}
            dimmed={isCommandPaletteOpen}
            isRewindMode={isRewindPickerOpen}
            rewindTargetMessageId={isRewindPickerOpen ? selectedRewindCandidate?.message.id ?? null : null}
            rewindCandidateIds={isRewindPickerOpen ? rewindCandidateIds : undefined}
            onScrollOffsetRequest={isRewindPickerOpen ? setScrollOffset : undefined}
            expandedToolIds={expandedToolIds}
            selectedToolId={selectedTool?.id ?? null}
            isToolMode={isToolMode}
          />
          {isCommandPaletteOpen && (
            <CommandPalette
              onSelect={handlePaletteSelect}
              onClose={() => setIsCommandPaletteOpen(false)}
            />
          )}
        </>
      )}
      {pendingApproval ? (
        <ApprovalPrompt command={pendingApproval.command} onRespond={(approved) => { pendingApproval.resolve(approved); setPendingApproval(null); }} />
      ) : agentInteractions[0] ? (
        <AgentInteractionPrompt participantId={agentInteractions[0].participantId} request={agentInteractions[0].request} onRespond={(response) => {
          const current = agentInteractions[0];
          if (!current) return;
          void coordinatorRef.current?.respondToInteraction(current.participantId, current.request.id, response)
            .catch((error) => addToast(error instanceof Error ? error.message : String(error)))
            .finally(() => setAgentInteractions((items) => items.slice(1)));
        }} />
      ) : pendingRewind ? (
        <RewindPrompt request={pendingRewind} onRespond={(approved) => {
          const request = pendingRewind;
          setPendingRewind(null);
          setScrollOffset(0);
          if (approved) void performRewind(request);
        }} />
      ) : isRewindPickerOpen ? (
        <RewindModePrompt
          selectedCandidate={selectedRewindCandidate}
          selectedIndex={Math.min(rewindPickerIndex, Math.max(0, rewindCandidates.length - 1))}
          candidateCount={rewindCandidates.length}
          onMove={moveRewindPicker}
          onSelect={selectRewindCandidate}
          onClose={() => { setIsRewindPickerOpen(false); setScrollOffset(0); }}
        />
      ) : isImportPromptOpen ? (
        <ImportPrompt onSubmit={handleImportSubmit} onClose={() => setIsImportPromptOpen(false)} />
      ) : (
        <>
          {workState.active.map((activity) => {
            const participant = participants.find((candidate) => candidate.id === activity.participantId);
            const label = activity.participantId === SQUIRL_PARTICIPANT.id
              ? pipelineStatus ? formatPipelineStatus(pipelineStatus) : 'Squirl is working…'
              : `${participant?.label ?? activity.participantId} is ${activity.detail ? `running ${activity.detail}` : 'working'}…`;
            return <Box key={activity.turnId} paddingX={2}><Text color="yellow">{label}</Text></Box>;
          })}
          {workState.queued.slice(0, 3).map((turn, index) => (
            <Box key={turn.id} paddingX={2}><Text dimColor>outbox @{turn.participantId} #{index + 1}: {turn.input.slice(0, 60)}  ctrl+x remove selected</Text></Box>
          ))}
          <InputArea
            value={inputValue}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            focus={!isModelMenuOpen && !isContextMenuOpen && !isCommandPaletteOpen && !isRewindPickerOpen && !isRoomRosterOpen && !isRecipientPickerOpen && agentInteractions.length === 0}
            recipientId={selectedRecipientId}
          />
        </>
      )}
      <StatusBar tokenCount={tokenCount} contextWindow={contextWindow} isStreaming={workState.active.some((activity) => activity.participantId === selectedRecipientId && activity.cancellable)} toolStatus={isToolMode ? 'tool activity: ↑/↓ select · enter toggle · esc close' : toolStatus} tokensPerSecond={tokensPerSecond} modelName={modelDisplay} workingDir={workingDir} commandQuery={commandQuery} commandIndex={commandIndex} statusEmitter={statusEmitterRef.current} indexEnabled={config?.index?.enabled ?? false} storeName={config?.index?.store ? `${config.index.store}${config.index.chromaUrl ? ` (${config.index.chromaUrl.replace(/^https?:\/\//, '')})` : ''}` : ''} embedderName={embedderDisplay} mouseMode={mouseMode} pipelineStatus={pipelineStatus} />
    </Box>
  );
};
