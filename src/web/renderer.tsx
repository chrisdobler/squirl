import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SquirlConfig } from '../config.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { Message } from '../types.js';
import type { AppState, ChatEvent, ContextFileSummary, RuntimeStatus, ToolApprovalRequest } from './types.js';
import type { Participant, ParticipantColor } from '../agents/types.js';
import { SQUIRL_PARTICIPANT, USER_PARTICIPANT, buildRegistry, resolveParticipant, roomMembers } from '../agents/participants.js';
import './styles.css';

const PARTICIPANT_CSS_COLOR: Record<ParticipantColor, string> = {
  cyan: '#22d3ee', green: '#4ade80', yellow: '#facc15', magenta: '#e879f9', blue: '#60a5fa', gray: '#9ca3af',
};

const API_BASE = import.meta.env.VITE_SQUIRL_API_BASE || window.location.origin;

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'] },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function messageLabel(message: Message, registry: Map<string, Participant>): string {
  if (message.role === 'tool') return message.toolName;
  return resolveParticipant(message, registry).label;
}

function visibleAssistantContent(content: string, showThinking: boolean): string {
  if (showThinking) return content;
  return content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

function defaultStatus(): RuntimeStatus {
  return {
    selectedModel: { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
    modelDisplay: 'Claude Sonnet 4.6',
    workingDir: '',
    tokenCount: 0,
    contextWindow: 0,
    isStreaming: false,
    toolStatus: '',
    tokensPerSecond: 0,
    indexEnabled: false,
    storeName: '',
    embedderName: '',
    pipelineStatus: null,
  };
}

function SettingsPanel({
  state,
  onSave,
  onDetectLocal,
}: {
  state: AppState;
  onSave: (config: SquirlConfig) => Promise<void>;
  onDetectLocal: (url: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SquirlConfig>(state.config);
  useEffect(() => setDraft(state.config), [state.config]);

  const updateIndex = (patch: Partial<NonNullable<SquirlConfig['index']>>) => {
    setDraft((prev) => ({
      ...prev,
      index: {
        enabled: prev.index?.enabled ?? false,
        store: prev.index?.store ?? 'local-chroma',
        chromaUrl: prev.index?.chromaUrl ?? 'http://localhost:8000',
        embedder: prev.index?.embedder ?? 'local',
        ...prev.index,
        ...patch,
      },
    }));
  };

  const updateAgents = (patch: Partial<NonNullable<SquirlConfig['agents']>>) => {
    setDraft((prev) => ({ ...prev, agents: { ...prev.agents, ...patch } }));
  };

  return (
    <section className="panel settings">
      <header>
        <h2>Settings</h2>
        <button className="primary" onClick={() => void onSave(draft)}>Save</button>
      </header>

      <label>
        Default provider
        <select value={draft.defaultProvider ?? 'anthropic'} onChange={(event) => setDraft({ ...draft, defaultProvider: event.target.value as SquirlConfig['defaultProvider'] })}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="local">Local</option>
        </select>
      </label>

      <label>
        Default model
        <input value={draft.defaultModel ?? ''} onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })} placeholder="claude-sonnet-4-6" />
      </label>

      <label>
        Anthropic API key
        <input type="password" value={draft.anthropicApiKey ?? ''} onChange={(event) => setDraft({ ...draft, anthropicApiKey: event.target.value })} />
      </label>

      <label>
        OpenAI API key
        <input type="password" value={draft.openaiApiKey ?? ''} onChange={(event) => setDraft({ ...draft, openaiApiKey: event.target.value })} />
      </label>

      <label>
        Local model URL
        <span className="inline">
          <input value={draft.localBaseUrl ?? 'http://localhost:8000/v1'} onChange={(event) => setDraft({ ...draft, localBaseUrl: event.target.value })} />
          <button onClick={() => void onDetectLocal(draft.localBaseUrl ?? 'http://localhost:8000/v1')}>Detect</button>
        </span>
      </label>

      <label>
        Mouse scroll lines
        <input type="number" min="1" max="30" value={draft.mouseScrollLines ?? 5} onChange={(event) => setDraft({ ...draft, mouseScrollLines: Number(event.target.value) })} />
      </label>

      <div className="divider" />

      <label className="check">
        <input type="checkbox" checked={draft.index?.enabled ?? false} onChange={(event) => updateIndex({ enabled: event.target.checked })} />
        Enable semantic memory
      </label>

      <label>
        Vector store
        <select value={draft.index?.store ?? 'local-chroma'} onChange={(event) => updateIndex({ store: event.target.value as 'local-chroma' | 'remote-chroma' | 'null' })}>
          <option value="local-chroma">Local Chroma</option>
          <option value="remote-chroma">Remote Chroma</option>
          <option value="null">Null</option>
        </select>
      </label>

      <label>
        Chroma URL
        <input value={draft.index?.chromaUrl ?? 'http://localhost:8000'} onChange={(event) => updateIndex({ chromaUrl: event.target.value })} />
      </label>

      <label>
        Chroma auth token
        <input type="password" value={draft.index?.chromaAuthToken ?? ''} onChange={(event) => updateIndex({ chromaAuthToken: event.target.value })} />
      </label>

      <label>
        Collection
        <input value={draft.index?.collection ?? 'squirl-messages'} onChange={(event) => updateIndex({ collection: event.target.value })} />
      </label>

      <label>
        Embedder
        <select value={draft.index?.embedder ?? 'local'} onChange={(event) => updateIndex({ embedder: event.target.value as 'openai' | 'local' })}>
          <option value="openai">OpenAI</option>
          <option value="local">Local</option>
        </select>
      </label>

      <label>
        Embedder model
        <input value={draft.index?.embedderModel ?? ''} onChange={(event) => updateIndex({ embedderModel: event.target.value })} placeholder="nomic-embed-text" />
      </label>

      <label>
        Embedder URL
        <input value={draft.index?.embedderUrl ?? 'http://localhost:11434'} onChange={(event) => updateIndex({ embedderUrl: event.target.value })} />
      </label>

      <label>
        Meta provider
        <select value={draft.index?.metaProvider ?? ''} onChange={(event) => updateIndex({ metaProvider: event.target.value ? event.target.value as 'openai' | 'anthropic' | 'local' : undefined })}>
          <option value="">Default</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="local">Local</option>
        </select>
      </label>

      <label>
        Meta model
        <input value={draft.index?.metaModel ?? ''} onChange={(event) => updateIndex({ metaModel: event.target.value })} placeholder="gpt-4o-mini" />
      </label>

      <label>
        Recall K
        <input type="number" min="1" max="50" value={draft.index?.recallK ?? 10} onChange={(event) => updateIndex({ recallK: Number(event.target.value) })} />
      </label>

      <div className="divider" />

      <h3>Remote agents</h3>
      <p className="hint">Add agents from chat with <code>/agent add claude-code</code> or <code>/agent add codex</code>, then address them with <code>@cc</code> / <code>@codex</code>.</p>

      <label className="check">
        <input type="checkbox" checked={draft.agents?.autoHandoff ?? false} onChange={(event) => updateAgents({ autoHandoff: event.target.checked })} />
        Auto-handoff (let an agent's @mention route to another participant)
      </label>

      <label>
        Max handoff hops
        <input type="number" min="1" max="10" value={draft.agents?.maxHops ?? 3} onChange={(event) => updateAgents({ maxHops: Number(event.target.value) })} />
      </label>

      <label>
        Default Claude permission mode
        <select value={draft.agents?.defaultClaudePermissionMode ?? 'default'} onChange={(event) => updateAgents({ defaultClaudePermissionMode: event.target.value as NonNullable<SquirlConfig['agents']>['defaultClaudePermissionMode'] })}>
          <option value="default">default (asks before edits/commands)</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="plan">plan</option>
          <option value="bypassPermissions">bypassPermissions (dangerous)</option>
        </select>
      </label>

      <label>
        Default Codex sandbox
        <select value={draft.agents?.defaultCodexSandbox ?? 'read-only'} onChange={(event) => updateAgents({ defaultCodexSandbox: event.target.value as NonNullable<SquirlConfig['agents']>['defaultCodexSandbox'] })}>
          <option value="read-only">read-only</option>
          <option value="workspace-write">workspace-write</option>
          <option value="danger-full-access">danger-full-access (dangerous)</option>
        </select>
      </label>

      <label>
        claude binary
        <input value={draft.agents?.claudeBin ?? ''} onChange={(event) => updateAgents({ claudeBin: event.target.value || undefined })} placeholder="claude" />
      </label>

      <label>
        codex binary
        <input value={draft.agents?.codexBin ?? ''} onChange={(event) => updateAgents({ codexBin: event.target.value || undefined })} placeholder="codex" />
      </label>
    </section>
  );
}

function ModelPanel({ current, onSelect, onDetect }: {
  current: SelectedModel;
  onSelect: (model: SelectedModel) => Promise<void>;
  onDetect: (url: string) => Promise<void>;
}) {
  const [localUrl, setLocalUrl] = useState(current.provider === 'local' ? current.baseUrl ?? 'http://localhost:8000/v1' : 'http://localhost:8000/v1');
  const [manualModel, setManualModel] = useState('');

  return (
    <section className="panel">
      <header>
        <h2>Models</h2>
        <button onClick={() => void api<{ content: string }>('/api/model/test', { method: 'POST', body: JSON.stringify({ model: current }) }).then((result) => {
          window.alert(`Model responded: ${result.content || '(empty)'}`);
        }).catch((err) => {
          window.alert(err instanceof Error ? err.message : String(err));
        })}>Test active</button>
      </header>
      {PROVIDERS.map((provider) => (
        <div key={provider.id} className="modelGroup">
          <h3>{provider.label}</h3>
          {provider.models.map((model) => (
            <button
              key={model}
              className={current.id === model ? 'selected rowButton' : 'rowButton'}
              onClick={() => void onSelect({ id: model, label: model, provider: provider.id })}
            >
              <span>{model}</span>
              {current.id === model && <strong>active</strong>}
            </button>
          ))}
        </div>
      ))}
      <div className="modelGroup">
        <h3>Local</h3>
        <label>
          Base URL
          <span className="inline">
            <input value={localUrl} onChange={(event) => setLocalUrl(event.target.value)} />
            <button onClick={() => void onDetect(localUrl)}>Detect</button>
          </span>
        </label>
        <label>
          Manual model
          <span className="inline">
            <input value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder="llama3, qwen, mistral..." />
            <button onClick={() => manualModel && void onSelect({ id: manualModel, label: manualModel, provider: 'local', baseUrl: localUrl })}>Use</button>
          </span>
        </label>
      </div>
    </section>
  );
}

function ContextPanel({ files, onAdd, onRemove, onClear }: {
  files: ContextFileSummary[];
  onAdd: (path: string) => Promise<void>;
  onRemove: (path: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void api<{ files: string[] }>(`/api/files?q=${encodeURIComponent(query)}`).then((result) => setWorkspaceFiles(result.files));
    }, 150);
    return () => clearTimeout(timeout);
  }, [query]);

  return (
    <section className="panel">
      <header>
        <h2>Context</h2>
        <button onClick={() => void onClear()}>Clear</button>
      </header>
      <label>
        Add file
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspace files" />
      </label>
      <div className="fileList">
        {workspaceFiles.slice(0, 20).map((path) => (
          <button key={path} className="rowButton" onClick={() => void onAdd(path)}>
            <span>{path}</span>
          </button>
        ))}
      </div>
      <div className="divider" />
      <h3>Attached</h3>
      {files.length === 0 ? <p className="muted">No files in context</p> : files.map((file) => (
        <button key={file.path} className="rowButton selected" onClick={() => void onRemove(file.path)}>
          <span>{file.path}</span>
          <strong>{formatTokens(file.tokens)}</strong>
        </button>
      ))}
    </section>
  );
}

function ImportPanel({ onImport, onRecall }: {
  onImport: (path: string) => Promise<void>;
  onRecall: (query: string) => Promise<void>;
}) {
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');

  const pickPath = async () => {
    const selected = await window.squirlDesktop?.selectPath({ directories: true });
    if (selected) setPath(selected);
  };

  return (
    <section className="panel">
      <header><h2>Memory</h2></header>
      <label>
        ChatGPT export path
        <span className="inline">
          <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="~/Downloads/chatgpt-export" />
          {window.squirlDesktop && <button onClick={() => void pickPath()}>Pick</button>}
          <button onClick={() => path && void onImport(path)}>Import</button>
        </span>
      </label>
      <label>
        Recall
        <span className="inline">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prior conversations" />
          <button onClick={() => query && void onRecall(query)}>Search</button>
        </span>
      </label>
    </section>
  );
}

function RewindPanel({ onRewind }: { onRewind: () => Promise<void> }) {
  return (
    <section className="panel rewindPanel">
      <header><h2>Rewind</h2></header>
      <p className="muted">Open the visual rewind picker and choose a retained turn. Imported archives stay immutable.</p>
      <button className="danger" onClick={() => void onRewind()}>Open rewind picker</button>
    </section>
  );
}

function MessageView({ message, showThinking, registry }: { message: Message; showThinking: boolean; registry: Map<string, Participant> }) {
  const content = message.role === 'assistant' ? visibleAssistantContent(message.content, showThinking) : message.content;
  const participant = message.role === 'tool' ? undefined : resolveParticipant(message, registry);
  const isRemoteAgent = participant ? participant.kind !== 'user' && participant.kind !== 'local-llm' : false;
  const labelColor = isRemoteAgent && participant ? PARTICIPANT_CSS_COLOR[participant.color] : undefined;
  return (
    <article className={`message ${message.role}`} data-participant={message.participantId ?? ''}>
      <div className="messageMeta">
        <span style={labelColor ? { color: labelColor, fontWeight: 600 } : undefined}>{messageLabel(message, registry)}</span>
        {message.role === 'assistant' && message.isStreaming && <strong>streaming</strong>}
      </div>
      <pre>{content || (message.role === 'assistant' && message.isStreaming ? '_' : '')}</pre>
    </article>
  );
}

function ApprovalModal({ request, onRespond }: {
  request: ToolApprovalRequest;
  onRespond: (approved: boolean) => Promise<void>;
}) {
  return (
    <div className="modalShade">
      <div className="modal">
        <h2>Approve Network Command</h2>
        <p>The model requested a command that can touch the network.</p>
        <pre>{request.command}</pre>
        <footer>
          <button onClick={() => void onRespond(false)}>Block</button>
          <button className="danger" onClick={() => void onRespond(true)}>Allow</button>
        </footer>
      </div>
    </div>
  );
}

function RoomRosterModal({ participants, onClose }: { participants: Participant[]; onClose: () => void }) {
  const members = roomMembers(participants);
  return (
    <div className="modalShade" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>◈ In this room ({members.length})</h2>
          <button onClick={onClose}>Close</button>
        </header>
        <div className="rosterList">
          {members.map((p) => {
            const isRemote = p.kind !== 'user' && p.kind !== 'local-llm';
            return (
              <div className="rosterRow" key={p.id}>
                <span className="rosterDot" style={{ background: PARTICIPANT_CSS_COLOR[p.color] }} aria-hidden="true" />
                <span className="rosterName" style={{ color: PARTICIPANT_CSS_COLOR[p.color] }}>{p.label}</span>
                <span className="rosterHandle">{isRemote ? `@${p.id}` : 'local'}</span>
                <span className="rosterMeta">{p.status ?? 'ready'}{p.mode ? ` · ${p.mode}` : ''}</span>
              </div>
            );
          })}
        </div>
        <p className="hint">Invite with <code>/agent add claude-code</code> or <code>/agent add codex</code>; address with <code>@cc</code> / <code>@codex</code>.</p>
      </div>
    </div>
  );
}

function RewindModal({ candidates, onClose, onApply }: {
  candidates: Array<{ label: string; preview: string } & Record<string, unknown>>;
  onClose: () => void;
  onApply: (candidate: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <div className="modalShade">
      <div className="modal wide">
        <h2>Rewind Conversation</h2>
        <p>Choose the point to retain; later Squirl-owned messages will be removed.</p>
        <div className="candidateList">
          {candidates.map((candidate, index) => (
            <button key={`${candidate.messageId}-${index}`} className="rowButton" onClick={() => void onApply(candidate)}>
              <span>{candidate.label}</span>
              <small>{candidate.preview}</small>
            </button>
          ))}
        </div>
        <footer><button onClick={onClose}>Cancel</button></footer>
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [input, setInput] = useState('');
  const [activePanel, setActivePanel] = useState<'settings' | 'models' | 'context' | 'memory' | 'rewind'>('context');
  const [showThinking, setShowThinking] = useState(false);
  const [approval, setApproval] = useState<ToolApprovalRequest | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [rewindCandidates, setRewindCandidates] = useState<Array<{ label: string; preview: string } & Record<string, unknown>> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const [isAtLatest, setIsAtLatest] = useState(true);

  const status = state?.status ?? defaultStatus();
  const messages = state?.messages ?? [];
  const participants = state?.participants ?? [USER_PARTICIPANT, SQUIRL_PARTICIPANT];
  const participantRegistry = useMemo(() => buildRegistry(participants), [participants]);
  const lastMessage = messages[messages.length - 1];
  const scrollSignature = `${messages.length}:${lastMessage?.id ?? ''}:${lastMessage?.content.length ?? 0}`;

  const loadState = async () => {
    setState(await api<AppState>('/api/state'));
  };

  useEffect(() => { void loadState(); }, []);
  useEffect(() => {
    if (status.isStreaming) return;
    const interval = window.setInterval(() => {
      void loadState().catch(() => {
        // The server may be restarting during development; keep the current UI.
      });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [status.isStreaming]);

  const scrollToLatest = (behavior: ScrollBehavior = 'auto') => {
    const list = listRef.current;
    if (!list) return;
    bottomRef.current?.scrollIntoView({ block: 'end', behavior });
    list.scrollTop = list.scrollHeight;
    stickToBottomRef.current = true;
    setIsAtLatest(true);
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || messages.length === 0) return;

    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      stickToBottomRef.current = true;
    }

    if (!stickToBottomRef.current) return;

    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      nestedFrame = window.requestAnimationFrame(() => scrollToLatest('auto'));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (nestedFrame) window.cancelAnimationFrame(nestedFrame);
    };
  }, [scrollSignature, messages.length]);

  const handleMessageScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atLatest = distanceFromBottom < 32;
    stickToBottomRef.current = atLatest;
    setIsAtLatest(atLatest);
  };

  const pushToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3500);
  };

  const sendMessage = async () => {
    const message = input.trim();
    if (!message || status.isStreaming) return;
    // /room opens the roster client-side (the modal lives here, not on the server).
    if (message === '/room') { setInput(''); setRosterOpen(true); return; }
    stickToBottomRef.current = true;
    setInput('');
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ChatEvent;
        if (event.type === 'state') setState(event.state);
        if (event.type === 'message') setState((prev) => prev ? { ...prev, messages: [...prev.messages, event.message] } : prev);
        if (event.type === 'assistant-update') {
          setState((prev) => prev ? { ...prev, messages: prev.messages.map((msg) => msg.id === event.message.id ? event.message : msg) } : prev);
        }
        if (event.type === 'token') {
          setState((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              messages: prev.messages.map((msg) => msg.id === event.assistantId && msg.role === 'assistant'
                ? { ...msg, content: msg.content + event.token }
                : msg),
            };
          });
        }
        if (event.type === 'assistant-final') {
          setState((prev) => prev ? { ...prev, messages: prev.messages.map((msg) => msg.id === event.message.id ? event.message : msg) } : prev);
        }
        if (event.type === 'status') setState((prev) => prev ? { ...prev, status: event.status } : prev);
        if (event.type === 'agent-status') {
          setState((prev) => prev ? { ...prev, participants: prev.participants.map((p) => p.id === event.participantId ? { ...p, status: event.status as Participant['status'] } : p) } : prev);
        }
        if (event.type === 'tool-approval') setApproval(event.request);
        if (event.type === 'toast') pushToast(event.message);
        if (event.type === 'error') pushToast(event.message);
      }
    }
    await loadState();
  };

  const saveConfig = async (config: SquirlConfig) => {
    setState(await api<AppState>('/api/config', { method: 'POST', body: JSON.stringify(config) }));
    pushToast('Settings saved.');
  };

  const selectModel = async (model: SelectedModel) => {
    setState(await api<AppState>('/api/model', { method: 'POST', body: JSON.stringify({ model }) }));
  };

  const detectLocal = async (baseUrl: string) => {
    const result = await api<{ backend: string; models: Array<{ id: string; contextWindow?: number }> }>(`/api/models?baseUrl=${encodeURIComponent(baseUrl)}`);
    if (result.models.length === 0) {
      pushToast(`No models detected at ${baseUrl}.`);
      return;
    }
    const first = result.models[0]!;
    await selectModel({ id: first.id, label: first.id, provider: 'local', baseUrl, backend: result.backend as SelectedModel['backend'], contextWindow: first.contextWindow });
    pushToast(`Selected ${first.id}.`);
  };

  const approve = async (approved: boolean) => {
    if (!approval) return;
    await api('/api/approve', { method: 'POST', body: JSON.stringify({ id: approval.id, approved }) });
    setApproval(null);
  };

  const activePanelView = useMemo(() => {
    if (!state) return null;
    if (activePanel === 'settings') return <SettingsPanel state={state} onSave={saveConfig} onDetectLocal={detectLocal} />;
    if (activePanel === 'models') return <ModelPanel current={status.selectedModel} onSelect={selectModel} onDetect={detectLocal} />;
    if (activePanel === 'memory') {
      return <ImportPanel
        onImport={async (path) => {
          const result = await api<{ count: number }>('/api/import', { method: 'POST', body: JSON.stringify({ source: 'chatgpt', path }) });
          pushToast(`Imported ${result.count} turns.`);
          await loadState();
        }}
        onRecall={async (query) => {
          await api('/api/recall', { method: 'POST', body: JSON.stringify({ query }) });
          await loadState();
        }}
      />;
    }
    if (activePanel === 'rewind') {
      return <RewindPanel onRewind={async () => {
        const result = await api<{ candidates: Array<{ label: string; preview: string } & Record<string, unknown>> }>('/api/rewind/candidates');
        setRewindCandidates(result.candidates);
      }} />;
    }
    return <ContextPanel
      files={state.contextFiles}
      onAdd={async (path) => setState(await api<AppState>('/api/context/add', { method: 'POST', body: JSON.stringify({ path }) }))}
      onRemove={async (path) => setState(await api<AppState>('/api/context/remove', { method: 'POST', body: JSON.stringify({ path }) }))}
      onClear={async () => setState(await api<AppState>('/api/context/clear', { method: 'POST' }))}
    />;
  }, [activePanel, state, status.selectedModel, approval]);

  return (
    <main className="appShell">
      <aside className="leftRail">
        <div className="brand">
          <img src="/logo.png" alt="" />
          <div>
            <h1>squirl</h1>
            <span>{status.workingDir || 'loading...'}</span>
          </div>
        </div>
        <nav>
          {(['context', 'models', 'memory', 'rewind', 'settings'] as const).map((panel) => (
            <button key={panel} className={activePanel === panel ? 'active' : ''} onClick={() => setActivePanel(panel)}>
              {panel}
            </button>
          ))}
        </nav>
        <div className="telemetry">
          <span>model</span><strong>{status.modelDisplay}</strong>
          <span>context</span><strong>{formatTokens(status.tokenCount)} / {formatTokens(status.contextWindow)}</strong>
          <span>speed</span><strong>{status.tokensPerSecond} t/s</strong>
          <span>memory</span><strong>{status.indexEnabled ? status.storeName || 'enabled' : 'off'}</strong>
        </div>
      </aside>

      <section className="chatPane">
        <header className="topBar">
          <div>
            <strong>{status.pipelineStatus ? `${status.pipelineStatus.stage}${status.pipelineStatus.detail ? ` · ${status.pipelineStatus.detail}` : ''}` : status.toolStatus || 'ready'}</strong>
            <span>{status.embedderName || 'index not configured'}</span>
          </div>
          <div className="topActions">
            <button className="chip" onClick={() => setRosterOpen(true)} title="Show who is in the room">
              ◈ {roomMembers(participants).length} in room
            </button>
            <label className="check">
              <input type="checkbox" checked={showThinking} onChange={(event) => setShowThinking(event.target.checked)} />
              thinking
            </label>
            {status.isStreaming && <button className="danger" onClick={() => void api('/api/cancel', { method: 'POST' }).then(loadState)}>Cancel</button>}
          </div>
        </header>

        <div className="messageList" ref={listRef} onScroll={handleMessageScroll}>
          {messages.length === 0 ? (
            <div className="emptyState">
              <h2>Start a Squirl session</h2>
              <p>Ask a question, attach files from Context, or import ChatGPT history from Memory.</p>
            </div>
          ) : messages.map((message) => <MessageView key={message.id} message={message} showThinking={showThinking} registry={participantRegistry} />)}
          <div ref={bottomRef} className="bottomSentinel" aria-hidden="true" />
          {!isAtLatest && (
            <button className="latestButton" onClick={() => scrollToLatest('smooth')}>
              Latest
            </button>
          )}
        </div>

        <footer className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Type a message, slash command, or @file reference..."
          />
          <button className="primary" disabled={status.isStreaming} onClick={() => void sendMessage()}>Send</button>
        </footer>
      </section>

      <aside className="rightPane">{activePanelView}</aside>

      {rosterOpen && <RoomRosterModal participants={participants} onClose={() => setRosterOpen(false)} />}
      {approval && <ApprovalModal request={approval} onRespond={approve} />}
      {rewindCandidates && <RewindModal
        candidates={rewindCandidates}
        onClose={() => setRewindCandidates(null)}
        onApply={async (candidate) => {
          if (!window.confirm('Remove later Squirl-owned messages after this point?')) return;
          setState(await api<AppState>('/api/rewind', { method: 'POST', body: JSON.stringify(candidate) }));
          setRewindCandidates(null);
        }}
      />}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
