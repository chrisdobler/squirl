import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { InputArea } from './components/InputArea.js';
import { StatusBar } from './components/StatusBar.js';
import { ModelPicker } from './components/ModelPicker.js';
import { ContextPicker } from './components/ContextPicker.js';
import { CommandPalette, type PaletteAction } from './components/CommandPalette.js';
import { ToastContainer, type ToastMessage } from './components/Toast.js';
import { Orchestrator } from './orchestrator.js';
import { getModelConfig } from './model-config.js';
import { loadHistory, appendMessage, readEntries, getAllHistoryFiles, rewindHistoryAfter } from './history.js';
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
import { OpenAIMetaLLM, AnthropicMetaLLM } from './search/meta-llm.js';
import type { MetaLLM } from './search/meta-extract.js';
import type { Message, AssistantMessage } from './types.js';
import type { QueryPipelineStatus } from './pipeline-status.js';
import { applyScrollDelta, nextAutoscrollEnabled, nextStreamingScrollOffset } from './scroll-behavior.js';
import { GroupChatCoordinator } from './agents/coordinator.js';
import { LocalSpawnTransport } from './agents/transport/local-spawn.js';
import { buildAgentDescriptor } from './agents/factory.js';
import { parseMentions } from './agents/mentions.js';
import { SQUIRL_PARTICIPANT, USER_PARTICIPANT } from './agents/participants.js';
import type { AgentEvent, AgentKind, Participant } from './agents/types.js';

function defaultModelFromConfig(config?: SquirlConfig): SelectedModel {
  const provider = config?.defaultProvider ?? 'anthropic';
  if (provider === 'openai') {
    return { id: config?.defaultModel ?? 'gpt-4o', label: config?.defaultModel ?? 'gpt-4o', provider: 'openai' };
  }
  if (provider === 'local') {
    const modelId = config?.defaultModel || 'default';
    return { id: modelId, label: modelId, provider: 'local', baseUrl: config?.localBaseUrl ?? 'http://localhost:8000/v1', backend: config?.localBackend };
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
  const [isRewindPickerOpen, setIsRewindPickerOpen] = useState(false);
  const [rewindPickerIndex, setRewindPickerIndex] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<{ command: string; resolve: (approved: boolean) => void } | null>(null);
  const [pendingRewind, setPendingRewind] = useState<RewindRequest | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState('');
  const [pipelineStatus, setPipelineStatus] = useState<QueryPipelineStatus | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const streamStartRef = useRef(0);
  const streamTokensRef = useRef(0);
  const streamBufferRef = useRef('');
  const latestAssistantRef = useRef<AssistantMessage | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orchestratorRef = useRef(new Orchestrator(workingDir));
  const statusEmitterRef = useRef(new StatusEmitter());
  const ingestQueueRef = useRef<IngestQueue | null>(null);
  const embedderRef = useRef<ReturnType<typeof createEmbedder> | null>(null);
  const vectorStoreRef = useRef<VectorStore | null>(null);
  const [selectedModel, setSelectedModel] = useState<SelectedModel>(() => defaultModelFromConfig(config));
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

  // ---- Multi-agent group chat ----
  const [participants, setParticipants] = useState<Participant[]>([USER_PARTICIPANT, SQUIRL_PARTICIPANT]);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  const participantsRef = useRef<Participant[]>(participants);
  participantsRef.current = participants;
  const agentContentRef = useRef<Map<string, string>>(new Map());
  const agentFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleAgentEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const runLocalTurnRef = useRef<(input: string, emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>>(async () => {});
  const coordinatorRef = useRef<GroupChatCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new GroupChatCoordinator({
      config: { autoHandoff: config?.agents?.autoHandoff, maxHops: config?.agents?.maxHops },
      transport: new LocalSpawnTransport(),
      localTurn: (input, emit, signal) => runLocalTurnRef.current(input, emit, signal),
    });
    coordinatorRef.current.onEvent((event) => handleAgentEventRef.current(event));
  }

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
    isActive: mouseMode && !isModelMenuOpen && !isContextMenuOpen && !isCommandPaletteOpen && !isRewindPickerOpen,
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
    })();
    return () => { cancelled = true; };
  }, [selectedModel.id, selectedModel.provider, selectedModel.baseUrl, selectedModel.backend, selectedModel.contextWindow]);

  useEffect(() => {
    if (isStreaming) return;
    const cfg = getModelConfig(selectedModel.id);
    const sysMsg = buildSystemPrompt(
      { workingDir, date: new Date().toISOString().slice(0, 10), modelId: selectedModel.id, platform: platform(), shell: process.env.SHELL ?? 'unknown', supportsTools: cfg.supportsTools },
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
        orchestratorRef.current.setMemoryPipeline(memoryPipeline);

        const files = getAllHistoryFiles();
        const allEntries = files.flatMap((f) => readEntries(f));
        await backfillFromHistory(queue, store, allEntries);
      } catch (err) {
        if (cancelled) return;
        const message = formatVectorStoreStartupError(err, storeConfig);
        embedderRef.current = null;
        vectorStoreRef.current = null;
        ingestQueueRef.current = null;
        orchestratorRef.current.setMemoryPipeline(null);
        statusEmitterRef.current.update({ phase: 'error', pending: 0, error: message });
      }
    })();

    return () => {
      cancelled = true;
      orchestratorRef.current.setMemoryPipeline(null);
    };
  }, [config?.index?.enabled]);

  const handleInputChange = useCallback((v: string) => {
    setInputValue(v);
    setCommandIndex(0);
  }, []);

  useInput((input, key) => {
    if (isModelMenuOpen || isContextMenuOpen || isCommandPaletteOpen || isImportPromptOpen || isRewindPickerOpen || pendingRewind) return;
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.ctrl && input === 'p') { if (!isStreaming) setIsCommandPaletteOpen(true); return; }
    if (key.ctrl && input === 'v') { setShowThinking((v) => !v); return; }
    if (key.ctrl && input === 's') { setMouseMode((v) => !v); return; }
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
      if (isStreaming && abortRef.current) {
        abortRef.current.abort();
        setIsStreaming(false);
        setToolStatus('');
        setPipelineStatus(null);
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            const final_ = { ...last, isStreaming: false, content: last.content + ' [cancelled]' } as AssistantMessage;
            updated[updated.length - 1] = final_;
            appendMessage(final_);
          }
          return updated;
        });
        abortRef.current = null;
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
        setMessages((prev) => [...prev, { id: event.messageId, role: 'assistant', content: '', isStreaming: true, participantId: pid }]);
        break;
      }
      case 'token': {
        agentContentRef.current.set(event.messageId, (agentContentRef.current.get(event.messageId) ?? '') + event.token);
        flushAgentContent();
        break;
      }
      case 'message-end': {
        agentContentRef.current.delete(event.messageId);
        const finalized: AssistantMessage = { id: event.messageId, role: 'assistant', content: event.content, isStreaming: false, participantId: pid };
        setMessages((prev) => prev.map((m) => (m.id === event.messageId ? finalized : m)));
        appendMessage(finalized);
        break;
      }
      case 'tool-start': {
        setToolStatus(`${participantLabel(event.participantId)}: ${event.toolName}`);
        break;
      }
      case 'tool-end': {
        setToolStatus('');
        const trimmed = event.result.length > 600 ? `${event.result.slice(0, 600)}…` : event.result;
        const toolMsg: Message = {
          id: crypto.randomUUID(), role: 'tool',
          toolCallId: event.toolId || crypto.randomUUID(),
          toolName: `${participantLabel(event.participantId)}:${event.toolName}`,
          content: trimmed || (event.ok ? '(ok)' : '(failed)'),
          participantId: event.participantId,
        };
        setMessages((prev) => [...prev, toolMsg]);
        appendMessage(toolMsg);
        break;
      }
      case 'session-status': {
        setParticipants((prev) => prev.map((p) => (p.id === event.participantId ? { ...p, status: event.status } : p)));
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
        if (msg.role === 'assistant') { assistantId = msg.id; emit({ type: 'message-start', participantId: SQUIRL_PARTICIPANT.id, messageId: msg.id }); }
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

  const addAgentCmd = useCallback(async (kind: AgentKind, opts?: { id?: string; model?: string }) => {
    try {
      const descriptor = buildAgentDescriptor({
        kind, cwd: workingDir, id: opts?.id, model: opts?.model,
        bin: kind === 'claude-code' ? config?.agents?.claudeBin : config?.agents?.codexBin,
        permissionMode: config?.agents?.defaultClaudePermissionMode,
        sandbox: config?.agents?.defaultCodexSandbox,
      });
      const participant = await coordinatorRef.current!.addAgent(descriptor);
      setParticipants(coordinatorRef.current!.listParticipants());
      return { ok: true as const, id: participant.id, label: participant.label };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [workingDir, config]);

  const stopAgentCmd = useCallback(async (id: string) => {
    if (!coordinatorRef.current!.hasAgent(id)) return false;
    await coordinatorRef.current!.removeAgent(id);
    setParticipants(coordinatorRef.current!.listParticipants());
    return true;
  }, []);

  const listAgentsCmd = useCallback(() => coordinatorRef.current!.listParticipants()
    .filter((p) => p.kind !== 'user' && p.kind !== 'local-llm')
    .map((p) => ({ id: p.id, label: p.label, status: p.status ?? '?', mode: p.mode ?? '' })), []);

  const runAgentDispatch = useCallback((value: string) => {
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: value };
    setMessages((prev) => [...prev, userMsg]);
    appendMessage(userMsg);
    setInputValue('');
    historyIndexRef.current = -1;
    savedInputRef.current = '';
    streamAutoscrollRef.current = true;
    setScrollOffset(0);
    setIsStreaming(true);
    const abortController = new AbortController();
    abortRef.current = abortController;
    coordinatorRef.current!.dispatch(value, abortController.signal)
      .catch((err) => addToast(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setIsStreaming(false);
        streamAutoscrollRef.current = false;
        setToolStatus('');
        abortRef.current = null;
      });
  }, [addToast]);

  // Auto-start agents configured to launch on startup.
  useEffect(() => {
    const defaults = config?.agents?.defaults;
    if (!defaults?.length) return;
    (async () => {
      for (const d of defaults) await addAgentCmd(d.kind, { id: d.id, model: d.model });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        openSetup: onSetup,
        embedder: embedderRef.current ?? undefined,
        vectorStore: vectorStoreRef.current ?? undefined,
        indexEnabled: config?.index?.enabled ?? false,
        recallQuery: value.trim().startsWith('/recall ') ? value.trim().slice(8).trim() : '',
        commandInput: value.trim(),
        requestRewind: (request) => setPendingRewind(request),
        openRewindPicker,
        addAgent: addAgentCmd,
        stopAgent: stopAgentCmd,
        listAgents: listAgentsCmd,
      });
      return;
    }

    if (isStreaming) return;

    // Group-chat routing: if the input @mentions a connected agent, route through the coordinator.
    const agentIds = listAgentsCmd().map((a) => a.id);
    if (agentIds.length > 0) {
      const mention = parseMentions(value.trim(), [SQUIRL_PARTICIPANT.id, ...agentIds]);
      if (mention.targets.some((id) => agentIds.includes(id))) {
        runAgentDispatch(value.trim());
        return;
      }
    }

    setInputValue('');
    historyIndexRef.current = -1;
    savedInputRef.current = '';
    streamAutoscrollRef.current = true;
    setScrollOffset(0);
    setIsStreaming(true);
    setTokensPerSecond(0);
    streamStartRef.current = Date.now();
    streamTokensRef.current = 0;
    streamBufferRef.current = '';
    latestAssistantRef.current = null;

    const abortController = new AbortController();
    abortRef.current = abortController;

    orchestratorRef.current.chat(
      value.trim(),
      messages,
      selectedModel,
      {
        onNewMessage: (msg) => {
          if (msg.role === 'assistant') {
            latestAssistantRef.current = msg;
          }
          setMessages(prev => [...prev, msg]);
          if (msg.role !== 'assistant') {
            appendMessage(msg);
          }
        },
        onToken: (token, assistant) => {
          latestAssistantRef.current = assistant;
          if (token) streamTokensRef.current++;
          streamBufferRef.current += token;

          // Throttle renders to ~30fps
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              const buffered = streamBufferRef.current;
              if (!buffered) return;
              streamBufferRef.current = '';

              const elapsed = (Date.now() - streamStartRef.current) / 1000;
              if (elapsed > 0.5) {
                setTokensPerSecond(Math.round(streamTokensRef.current / elapsed));
              }
              const latestAssistant = latestAssistantRef.current;
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant' && last.isStreaming && latestAssistant?.id === last.id) {
                  updated[updated.length - 1] = { ...last, ...latestAssistant };
                }
                return updated;
              });
            }, 33);
          }
        },
        onDone: (usage) => {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          const remaining = streamBufferRef.current;
          streamBufferRef.current = '';
          const latestAssistant = latestAssistantRef.current;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              const content = latestAssistant?.id === last.id ? latestAssistant.content : last.content + remaining;
              const finalized = {
                ...last,
                ...(latestAssistant?.id === last.id ? latestAssistant : {}),
                content,
                isStreaming: false,
              } as AssistantMessage;
              updated[updated.length - 1] = finalized;
              appendMessage(finalized);
            }
            return updated;
          });
        },
        onError: (error) => {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant' && last.isStreaming) {
              updated[updated.length - 1] = { ...last, content: `Error: ${error.message}`, isStreaming: false } as AssistantMessage;
            }
            return updated;
          });
        },
        onToolApproval: (_toolName, args) => {
          return new Promise<boolean>((resolve) => {
            setPendingApproval({ command: args.command as string, resolve });
          });
        },
        onToolStart: (name) => {
          setToolStatus(`Running ${name}...`);
        },
        onToolEnd: () => {
          setToolStatus('');
        },
        onMemoryStart: () => {
          setToolStatus('Recalling...');
        },
        onMemoryEnd: (inlineDisplay) => {
          setToolStatus('');
          if (inlineDisplay) {
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'tool' as const,
              toolCallId: 'memory',
              toolName: '/memory',
              content: inlineDisplay,
            }]);
          }
        },
        onStatus: (stage, detail) => {
          setPipelineStatus({ stage, detail });
        },
      },
      abortController.signal,
    ).then((newMessages) => {
      if (ingestQueueRef.current && config?.index?.enabled) {
        const pairs = messagesToTurnPairs(newMessages, 'current', 'squirl');
        for (const pair of pairs) ingestQueueRef.current.enqueue(pair);
      }
    }).finally(() => {
      setIsStreaming(false);
      streamAutoscrollRef.current = false;
      setToolStatus('');
      setPipelineStatus(null);
      abortRef.current = null;
    });
  };

  const commandQuery = inputValue.startsWith('/') ? inputValue.slice(1).toLowerCase() : null;

  const modelDisplay = selectedModel.provider === 'local'
    ? selectedModel.backend && selectedModel.backend !== 'unknown'
      ? `${selectedModel.id} (${BACKEND_DISPLAY_NAMES[selectedModel.backend]})`
      : selectedModel.id
    : selectedModel.label;
  const contextWindow = selectedModel.contextWindow ?? getModelConfig(selectedModel.id).contextWindow;
  const selectedRewindCandidate = rewindCandidates[Math.min(rewindPickerIndex, Math.max(0, rewindCandidates.length - 1))];
  const rewindCandidateIds = new Set(rewindCandidates.map((candidate) => candidate.message.id));
  const messageListHeight = Math.max(1, terminalRows - FIXED_CHROME_ROWS);

  return (
    <Box flexDirection="column" height={terminalRows}>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <Header />
      {isContextMenuOpen ? (
        <ContextPicker
          orchestrator={orchestratorRef.current}
          workingDir={workingDir}
          messages={messages}
          contextWindow={contextWindow}
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
        <InputArea
          value={inputValue}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          focus={!isModelMenuOpen && !isContextMenuOpen && !isCommandPaletteOpen && !isRewindPickerOpen}
        />
      )}
      <StatusBar tokenCount={tokenCount} contextWindow={contextWindow} isStreaming={isStreaming} toolStatus={toolStatus} tokensPerSecond={tokensPerSecond} modelName={modelDisplay} workingDir={workingDir} commandQuery={commandQuery} commandIndex={commandIndex} statusEmitter={statusEmitterRef.current} indexEnabled={config?.index?.enabled ?? false} storeName={config?.index?.store ? `${config.index.store}${config.index.chromaUrl ? ` (${config.index.chromaUrl.replace(/^https?:\/\//, '')})` : ''}` : ''} embedderName={embedderDisplay} mouseMode={mouseMode} pipelineStatus={pipelineStatus} />
    </Box>
  );
};
