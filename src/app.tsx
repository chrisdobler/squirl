import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { InputArea } from './components/InputArea.js';
import { StatusBar } from './components/StatusBar.js';
import { ModelPicker } from './components/ModelPicker.js';
import { ContextPicker } from './components/ContextPicker.js';
import { Orchestrator } from './orchestrator.js';
import { getModelConfig } from './model-config.js';
import { loadHistory, appendMessage, updateLastMessage, readEntries, getAllHistoryFiles } from './history.js';
import { matchCommand, filterCommands } from './commands/registry.js';
import { estimateTokens } from './context/token-estimator.js';
import { buildSystemPrompt } from './context/system-prompt.js';
import { useMouseWheel } from './hooks/useMouseWheel.js';
import { platform } from 'node:os';
import { fetchAvailableModels, detectLocalBackend, BACKEND_DISPLAY_NAMES } from './api.js';
import type { SelectedModel } from './components/ModelPicker.js';
import type { SquirlConfig } from './config.js';
import { createEmbedder } from './search/embedders/index.js';
import { createVectorStore } from './search/stores/index.js';
import { IngestQueue } from './search/ingest-queue.js';
import { StatusEmitter } from './search/status.js';
import { messagesToTurnPairs } from './search/turn-pair.js';
import { backfillFromHistory } from './search/backfill.js';
import type { VectorStore } from './search/types.js';
import type { Message, AssistantMessage } from './types.js';

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

interface AppProps {
  workingDir?: string;
  config?: SquirlConfig;
}

export const App: React.FC<AppProps> = ({
  workingDir = process.cwd(),
  config,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalRows = stdout.rows ?? 24;
  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [inputValue, setInputValue] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const streamStartRef = useRef(0);
  const streamTokensRef = useRef(0);
  const streamBufferRef = useRef('');
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
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScrollRef = useRef(0);

  // Reset scroll to bottom when new messages arrive or during streaming
  useEffect(() => {
    if (isStreaming) setScrollOffset(0);
  }, [messages.length, isStreaming]);

  const handleMaxScroll = useCallback((max: number) => {
    maxScrollRef.current = max;
  }, []);

  useMouseWheel({
    onScroll: (delta) => setScrollOffset((prev) => Math.max(0, Math.min(maxScrollRef.current, prev + delta))),
    isActive: !isModelMenuOpen && !isContextMenuOpen,
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
      { workingDir, date: new Date().toISOString().slice(0, 10), modelId: selectedModel.id, platform: platform(), shell: process.env.SHELL ?? 'unknown' },
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
      const embedder = createEmbedder({
        type: config.index!.embedder,
        apiKey: config.openaiApiKey,
        model: config.index!.embedderModel,
        baseUrl: config.index!.ollamaUrl,
      });
      const store = await createVectorStore({
        type: config.index!.store,
        chromaUrl: config.index!.chromaUrl,
        chromaAuthToken: config.index!.chromaAuthToken,
        collection: config.index!.collection,
      });

      if (cancelled) { await store.close(); return; }

      embedderRef.current = embedder;
      vectorStoreRef.current = store;

      const queue = new IngestQueue(embedder, store, statusEmitterRef.current);
      ingestQueueRef.current = queue;

      const files = getAllHistoryFiles();
      const allEntries = files.flatMap((f) => readEntries(f));
      await backfillFromHistory(queue, store, allEntries);
    })();

    return () => { cancelled = true; };
  }, [config?.index?.enabled]);

  const handleInputChange = useCallback((v: string) => {
    setInputValue(v);
    setCommandIndex(0);
  }, []);

  useInput((input, key) => {
    if (isModelMenuOpen || isContextMenuOpen) return;
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.ctrl && input === 'p') { if (!isStreaming) setIsModelMenuOpen(true); return; }
    if (key.ctrl && input === 'v') { setShowThinking((v) => !v); return; }
    // Shift+Up/Down to scroll message history
    if (key.shift && key.upArrow) { setScrollOffset((prev) => Math.min(maxScrollRef.current, prev + 3)); return; }
    if (key.shift && key.downArrow) { setScrollOffset((prev) => Math.max(0, prev - 3)); return; }
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
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            const final_ = { ...last, isStreaming: false, content: last.content + ' [cancelled]' } as AssistantMessage;
            updated[updated.length - 1] = final_;
            updateLastMessage(final_);
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
        embedder: embedderRef.current ?? undefined,
        vectorStore: vectorStoreRef.current ?? undefined,
        indexEnabled: config?.index?.enabled ?? false,
        recallQuery: value.trim().startsWith('/recall ') ? value.trim().slice(8).trim() : '',
      });
      return;
    }

    if (isStreaming) return;

    setInputValue('');
    historyIndexRef.current = -1;
    savedInputRef.current = '';
    setIsStreaming(true);
    setTokensPerSecond(0);
    streamStartRef.current = Date.now();
    streamTokensRef.current = 0;

    const abortController = new AbortController();
    abortRef.current = abortController;

    orchestratorRef.current.chat(
      value.trim(),
      messages,
      selectedModel,
      {
        onNewMessage: (msg) => {
          setMessages(prev => [...prev, msg]);
        },
        onToken: (token) => {
          streamTokensRef.current++;
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
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant' && last.isStreaming) {
                  updated[updated.length - 1] = { ...last, content: last.content + buffered };
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
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant' && last.isStreaming) {
              updated[updated.length - 1] = { ...last, content: last.content + remaining, isStreaming: false } as AssistantMessage;
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
        onToolStart: (name) => {
          setToolStatus(`Running ${name}...`);
        },
        onToolEnd: () => {
          setToolStatus('');
        },
      },
      abortController.signal,
    ).then((newMessages) => {
      // Persist all completed messages to history
      for (const msg of newMessages) {
        if (msg.role === 'assistant' && msg.isStreaming) continue;
        appendMessage(msg);
      }
      if (ingestQueueRef.current && config?.index?.enabled) {
        const pairs = messagesToTurnPairs(newMessages, 'current', 'squirl');
        for (const pair of pairs) ingestQueueRef.current.enqueue(pair);
      }
    }).finally(() => {
      setIsStreaming(false);
      setToolStatus('');
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

  return (
    <Box flexDirection="column" height={terminalRows}>
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
        />
      ) : (
        <MessageList messages={messages} showThinking={showThinking} scrollOffset={scrollOffset} onMaxScroll={handleMaxScroll} />
      )}
      <InputArea
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        focus={!isModelMenuOpen && !isContextMenuOpen}
      />
      <StatusBar tokenCount={tokenCount} contextWindow={contextWindow} isStreaming={isStreaming} toolStatus={toolStatus} tokensPerSecond={tokensPerSecond} modelName={modelDisplay} workingDir={workingDir} commandQuery={commandQuery} commandIndex={commandIndex} statusEmitter={statusEmitterRef.current} />
    </Box>
  );
};
