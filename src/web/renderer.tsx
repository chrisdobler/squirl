import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SquirlConfig } from '../config.js';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { EffortLevel, Message } from '../types.js';
import type { AppState, ChatEvent, ContextFileSummary, ParticipantContextPreview, RuntimeStatus, ToolApprovalRequest, EvalEvent, EvalRunRequest, HistoryEntry, JudgeSummary } from './types.js';
import type { AgentKind, Participant } from '../agents/types.js';
import type { CommandDescriptor, CommandSurface } from '../commands/registry.js';
import { PARTICIPANT_COLOR_VALUE, SQUIRL_PARTICIPANT, USER_PARTICIPANT, addressedParticipantLabel, buildRegistry, resolveParticipant, roomMembers } from '../agents/participants.js';
import { EvalDashboard } from './EvalDashboard.js';
import { ContextView } from './ContextView.js';
import { EvalRunView } from './EvalRunView.js';
import { MarkdownContent } from './MarkdownContent.js';
import { commandSelectionValue, filterCommandPalette, moveCommandSelection, resolveCommandSurface, shouldShowCommandPalette } from './command-palette.js';
import { parseMemoryLookup } from './memory-lookup.js';
import { restoredChatScrollTop, type ChatViewportSnapshot } from './chat-viewport.js';
import { groupMessageTurns } from '../tool-activity.js';
import { ToolActivityView } from './ToolActivityView.js';
import { chatActivityLabel } from './chat-activity.js';
import { RoomSidebarRoster } from './RoomSidebarRoster.js';
import { defaultUiState, type UiStatePatch, type UiStateV1 } from './ui-state.js';
import { ParticipantIdentity } from './ParticipantIdentity.js';
import './styles.css';

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
    contextWindow: null,
    contextBreakdown: { system: 0, files: 0, messages: 0 },
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
      <p className="hint">Use the Agents command surface to add Claude Code or Codex CLI, choose its model and effort, and connect it to the room.</p>

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

function ModelPanel({ current, onSelect, onDetect, initialState, onStateChange }: {
  current: SelectedModel;
  onSelect: (model: SelectedModel) => Promise<void>;
  onDetect: (url: string) => Promise<void>;
  initialState: UiStateV1['model']; onStateChange: (state: UiStateV1['model']) => void;
}) {
  const [localUrl, setLocalUrl] = useState(initialState.localUrl || (current.provider === 'local' ? current.baseUrl ?? 'http://localhost:8000/v1' : 'http://localhost:8000/v1'));
  const [manualModel, setManualModel] = useState(initialState.manualModel);
  useEffect(() => onStateChange({ localUrl, manualModel }), [localUrl, manualModel, onStateChange]);

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

function ImportPanel({ onImport, onRecall, initialState, onStateChange }: {
  onImport: (path: string) => Promise<void>;
  onRecall: (query: string) => Promise<void>;
  initialState: UiStateV1['memory']; onStateChange: (state: UiStateV1['memory']) => void;
}) {
  const [path, setPath] = useState(initialState.importPath);
  const [query, setQuery] = useState(initialState.recallQuery);
  useEffect(() => onStateChange({ importPath: path, recallQuery: query }), [path, query, onStateChange]);

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

function SurfaceFrame({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="commandSurface">
    <header className="commandSurfaceHeader"><div><span className="commandKicker">command</span><h2>/{title}</h2></div><div className="surfaceActions">{actions}<button onClick={onClose}>Close <kbd>Esc</kbd></button></div></header>
    <div className="commandSurfaceBody">{children}</div>
  </div>;
}

const SETTINGS_STEPS = ['profile', 'provider', 'model', 'credentials', 'memory', 'review'] as const;
function SettingsWizard({ state, onSave, onClose, onSaved, onDetectLocal }: { state: AppState; onSave: (config: SquirlConfig) => Promise<void>; onClose: () => void; onSaved: () => void; onDetectLocal: (url: string) => Promise<void> }) {
  const [draft, setDraft] = useState<SquirlConfig>(state.config);
  const profileCompletionOnly = !state.config.userProfile?.onboardingComplete;
  const [step, setStep] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  if (advanced) return <SettingsPanel state={{ ...state, config: draft }} onSave={async (next) => { setDraft(next); await onSave(next); onSaved(); }} onDetectLocal={onDetectLocal} />;
  const name = SETTINGS_STEPS[step]!;
  const updateIndex = (patch: Partial<NonNullable<SquirlConfig['index']>>) => setDraft((prev) => ({ ...prev, index: { enabled: false, store: 'local-chroma', embedder: 'local', ...prev.index, ...patch } }));
  return <div className="settingsWizard">
    <div className="wizardProgress">{SETTINGS_STEPS.map((item, i) => <span key={item} className={i === step ? 'active' : i < step ? 'done' : ''}>{i + 1}<small>{item}</small></span>)}</div>
    <section className="wizardCard">
      {name === 'profile' && <><h3>What should Squirl call you?</h3><p className="muted">Optional. Squirl never infers this from your computer, accounts, repositories, or imported conversations.</p><label>Preferred name<input value={draft.userProfile?.displayName ?? ''} onChange={(e) => setDraft({ ...draft, userProfile: { ...(e.target.value ? { displayName: e.target.value } : {}), onboardingComplete: true } })} placeholder="Leave blank to skip" /></label></>}
      {name === 'provider' && <><h3>Choose your default provider</h3><div className="choiceGrid">{(['anthropic', 'openai', 'local'] as const).map((provider) => <button key={provider} className={draft.defaultProvider === provider ? 'selected' : ''} onClick={() => setDraft({ ...draft, defaultProvider: provider })}><strong>{provider}</strong><span>{provider === 'local' ? 'OpenAI-compatible local gateway' : `${provider} hosted models`}</span></button>)}</div></>}
      {name === 'model' && <><h3>Choose the model</h3><label>Model ID<input value={draft.defaultModel ?? ''} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })} placeholder="Model name" /></label>{draft.defaultProvider === 'local' && <label>Local base URL<span className="inline"><input value={draft.localBaseUrl ?? 'http://localhost:8000/v1'} onChange={(e) => setDraft({ ...draft, localBaseUrl: e.target.value })}/><button onClick={() => void onDetectLocal(draft.localBaseUrl ?? 'http://localhost:8000/v1')}>Detect</button></span></label>}</>}
      {name === 'credentials' && <><h3>Credentials</h3><p className="muted">Leave an existing key unchanged, or enter a replacement.</p><label>Anthropic API key<input type="password" value={draft.anthropicApiKey ?? ''} onChange={(e) => setDraft({ ...draft, anthropicApiKey: e.target.value })}/></label><label>OpenAI API key<input type="password" value={draft.openaiApiKey ?? ''} onChange={(e) => setDraft({ ...draft, openaiApiKey: e.target.value })}/></label></>}
      {name === 'memory' && <><h3>Semantic memory</h3><label className="check"><input type="checkbox" checked={draft.index?.enabled ?? false} onChange={(e) => updateIndex({ enabled: e.target.checked })}/>Enable semantic memory</label>{draft.index?.enabled && <><label>Vector store<select value={draft.index.store ?? 'local-chroma'} onChange={(e) => updateIndex({ store: e.target.value as 'local-chroma'|'remote-chroma'|'null' })}><option value="local-chroma">Local Chroma</option><option value="remote-chroma">Remote Chroma</option><option value="null">Disabled/null</option></select></label><label>Chroma URL<input value={draft.index.chromaUrl ?? 'http://localhost:8000'} onChange={(e) => updateIndex({ chromaUrl: e.target.value })}/></label><label>Embedder<select value={draft.index.embedder ?? 'local'} onChange={(e) => updateIndex({ embedder: e.target.value as 'local'|'openai' })}><option value="local">Local</option><option value="openai">OpenAI</option></select></label></>}</>}
      {name === 'review' && <><h3>Review</h3><dl className="reviewGrid"><dt>Preferred name</dt><dd>{draft.userProfile?.displayName?.trim() || 'not provided'}</dd><dt>Provider</dt><dd>{draft.defaultProvider ?? 'anthropic'}</dd><dt>Model</dt><dd>{draft.defaultModel || 'provider default'}</dd><dt>Local URL</dt><dd>{draft.localBaseUrl || 'not configured'}</dd><dt>Memory</dt><dd>{draft.index?.enabled ? `${draft.index.store ?? 'local-chroma'} · ${draft.index.embedder ?? 'local'}` : 'off'}</dd></dl></>}
    </section>
    <footer className="wizardFooter"><button onClick={() => step === 0 ? onClose() : setStep(step - 1)}>{step === 0 ? 'Cancel' : 'Back'}</button><button onClick={() => setAdvanced(true)}>Advanced</button><button className="primary" disabled={saving} onClick={() => {
      if (profileCompletionOnly && name === 'profile') {
        setSaving(true);
        const next = { ...draft, userProfile: { ...(draft.userProfile?.displayName?.trim() ? { displayName: draft.userProfile.displayName.trim() } : {}), onboardingComplete: true } };
        void onSave(next).then(onSaved).finally(() => setSaving(false));
      } else if (step < SETTINGS_STEPS.length - 1) setStep(step + 1);
      else { setSaving(true); void onSave(draft).then(onSaved).finally(() => setSaving(false)); }
    }}>{saving ? 'Saving…' : profileCompletionOnly && name === 'profile' ? (draft.userProfile?.displayName?.trim() ? 'Save name' : 'Skip') : step < SETTINGS_STEPS.length - 1 ? 'Continue' : 'Save settings'}</button></footer>
  </div>;
}

function CommandPaletteView({ commands, query, selected, onSelected, onChoose }: { commands: CommandDescriptor[]; query: string; selected: number; onSelected: (index: number) => void; onChoose: (command: CommandDescriptor) => void }) {
  const matches = filterCommandPalette(commands, query);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  return <div id="slash-command-list" className="commandAutocomplete" role="listbox" aria-label="Slash commands"><div className="autocompleteHeader"><span>Commands</span><small>↑↓ navigate · Tab or Enter select · Esc close</small></div><div className="autocompleteList">{matches.length ? matches.map((command, index) => <button id={`slash-command-${command.name}`} ref={index === selected ? activeRef : undefined} type="button" role="option" aria-selected={index === selected} key={command.name} className={index === selected ? 'selected' : ''} onMouseEnter={() => onSelected(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(command)}><b className="selectionCursor" aria-hidden="true">{index === selected ? '›' : ''}</b><code>/{command.name}</code><span>{command.description}</span><small>{command.usage ?? `/${command.name}`}</small></button>) : <div className="autocompleteEmpty">No matching commands</div>}</div></div>;
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
}

function DirectoryPicker({ initialPath, workspacePath, onChoose, onClose }: {
  initialPath: string;
  workspacePath: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = async (path: string) => {
    setLoading(true);
    setError('');
    try {
      setListing(await api<DirectoryListing>(`/api/directories?path=${encodeURIComponent(path)}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(initialPath); }, []);
  return <div className="directoryPicker" role="dialog" aria-label="Choose project directory">
    <header><div><strong>Choose a project folder</strong><span>{listing?.path ?? initialPath}</span></div><button type="button" onClick={onClose} aria-label="Close folder browser">×</button></header>
    <div className="directoryPickerActions">
      <button type="button" disabled={!listing?.parent || loading} onClick={() => listing?.parent && void load(listing.parent)}>↑ Up</button>
      <button type="button" disabled={loading} onClick={() => void load(workspacePath)}>Workspace</button>
      <button type="button" disabled={loading} onClick={() => void load('~')}>Home</button>
    </div>
    <div className="directoryList">
      {loading && <p className="muted">Loading folders…</p>}
      {!loading && error && <p className="directoryError">{error}</p>}
      {!loading && !error && listing?.directories.length === 0 && <p className="muted">No visible folders here.</p>}
      {!loading && !error && listing?.directories.map((directory) => <button type="button" key={directory.path} onClick={() => void load(directory.path)}><span aria-hidden="true">▸</span><strong>{directory.name}</strong></button>)}
    </div>
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!listing || loading} onClick={() => listing && onChoose(listing.path)}>Use this folder</button></footer>
  </div>;
}

function AgentPanel({ participants, defaultCwd, onAdd, onStop, initialState, onStateChange }: {
  participants: Participant[];
  defaultCwd: string;
  onAdd: (kind: AgentKind, options: { id?: string; model?: string; effort?: EffortLevel; cwd?: string }) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  initialState: UiStateV1['agent']; onStateChange: (state: UiStateV1['agent']) => void;
}) {
  const [kind, setKind] = useState<AgentKind>(initialState.kind);
  const [id, setId] = useState(initialState.id);
  const [model, setModel] = useState(initialState.model);
  const [effort, setEffort] = useState<EffortLevel | ''>(initialState.effort);
  const [cwd, setCwd] = useState(initialState.cwd || defaultCwd);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [codexModels, setCodexModels] = useState<Array<{ id: string; label: string }>>([]);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const [codexModelsError, setCodexModelsError] = useState('');
  const agents = participants.filter((participant) => participant.kind === 'claude-code' || participant.kind === 'codex');
  useEffect(() => onStateChange({ kind, id, model, effort, cwd }), [kind, id, model, effort, cwd, onStateChange]);
  useEffect(() => {
    if (kind !== 'codex') return;
    let cancelled = false;
    setCodexModelsLoading(true);
    setCodexModelsError('');
    void api<{ models: Array<{ id: string; label: string }>; defaultModel?: string }>('/api/agents/models?kind=codex')
      .then((result) => {
        if (cancelled) return;
        setCodexModels(result.models);
        setModel((current) => result.models.some((option) => option.id === current)
          ? current
          : result.defaultModel ?? result.models[0]?.id ?? '');
      })
      .catch((error) => {
        if (!cancelled) setCodexModelsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!cancelled) setCodexModelsLoading(false); });
    return () => { cancelled = true; };
  }, [kind]);

  const add = async () => {
    setAdding(true);
    try {
      await onAdd(kind, {
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
        cwd: cwd.trim() || defaultCwd,
      });
      setId('');
    } catch {
      // The parent surfaces API failures as a toast.
    } finally {
      setAdding(false);
    }
  };

  return <div className="agentSurface">
    <section className="agentAddCard">
      <h3>Add a CLI agent</h3>
      <p className="hint">Starts the installed CLI in the project you choose and adds it to the recipient picker.</p>
      <div className="agentKindChoices">
        <button className={kind === 'claude-code' ? 'selected' : ''} onClick={() => { setKind('claude-code'); setModel(''); }}><strong>Claude Code</strong><span>Use the local <code>claude</code> CLI</span></button>
        <button className={kind === 'codex' ? 'selected' : ''} onClick={() => { setKind('codex'); setModel(''); }}><strong>Codex CLI</strong><span>Use the local <code>codex</code> CLI</span></button>
      </div>
      <div className="agentFields">
        <label className="agentCwdField">Project / working directory<div className="agentCwdInput"><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={defaultCwd} spellCheck={false} /><button type="button" onClick={() => setDirectoryPickerOpen(true)}>Browse…</button></div><small>Choose a folder, or enter an absolute, <code>~/…</code>, or workspace-relative path.</small></label>
        <label>Room name<input value={id} onChange={(event) => setId(event.target.value)} placeholder={kind === 'claude-code' ? 'cc' : 'codex'} /></label>
        {kind === 'codex'
          ? <label>Model<select value={model} disabled={codexModelsLoading || codexModels.length === 0} onChange={(event) => setModel(event.target.value)}>
              {codexModelsLoading && <option value="">Loading Codex models…</option>}
              {!codexModelsLoading && codexModels.length === 0 && <option value="">No Codex models available</option>}
              {codexModels.map((option) => <option key={option.id} value={option.id}>{option.label} ({option.id})</option>)}
            </select>{codexModelsError && <small className="directoryError">{codexModelsError}</small>}</label>
          : <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="fable (optional)" /></label>}
        <label>Effort<select value={effort} onChange={(event) => setEffort(event.target.value as EffortLevel | '')}><option value="">CLI default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
      </div>
      {directoryPickerOpen && <DirectoryPicker initialPath={cwd || defaultCwd} workspacePath={defaultCwd} onChoose={(path) => { setCwd(path); setDirectoryPickerOpen(false); }} onClose={() => setDirectoryPickerOpen(false)} />}
      <button className="primary agentAddButton" disabled={adding || (kind === 'codex' && (codexModelsLoading || !model))} onClick={() => void add()}>{adding ? 'Adding…' : `Add ${kind === 'claude-code' ? 'Claude Code' : 'Codex CLI'}`}</button>
    </section>
    <section className="connectedAgents">
      <h3>Connected agents</h3>
      {agents.length === 0 && <p className="muted">No CLI agents are connected.</p>}
      {agents.map((participant) => <div className="rosterRow" key={participant.id}>
        <ParticipantIdentity participant={participant} text={participant.label} className="rosterName" />
        <code>@{participant.id}</code>
        <span className="rosterMeta" title={participant.cwd}>{participant.kind === 'claude-code' ? 'Claude Code' : 'Codex CLI'} · {participant.status ?? 'ready'}{participant.cwd ? ` · ${participant.cwd}` : ''}</span>
        <button onClick={() => void onStop(participant.id).catch(() => {})}>Stop</button>
      </div>)}
    </section>
  </div>;
}

function MessageView({ message, showThinking, registry, rewindCandidate, rewindSelected, showMeta = true }: { message: Message; showThinking: boolean; registry: Map<string, Participant>; rewindCandidate?: boolean; rewindSelected?: boolean; showMeta?: boolean }) {
  const content = message.role === 'assistant' ? visibleAssistantContent(message.content, showThinking) : message.content;
  const displayContent = content || (message.role === 'assistant' && message.isStreaming ? '_' : '');
  const memoryLookup = message.role === 'tool' && message.toolCallId === 'memory' ? parseMemoryLookup(content) : null;
  const memoryQueries = message.role === 'tool' ? message.memoryLookup?.queries ?? [] : [];
  if (memoryLookup) {
    return <article id={`message-${message.id}`} className="message tool memoryLookupMessage">
      <details className="memoryLookup">
        <summary><span className="memoryLookupChevron" aria-hidden="true"/><strong>Memory Lookup</strong><span className="memoryLookupCount">{memoryLookup.count} {memoryLookup.count === 1 ? 'memory' : 'memories'}</span></summary>
        <div className="memoryLookupDetails">
          <p>These memories were added to the model's context for this response.</p>
          {memoryQueries.length ? <div className="memoryLookupQueries"><strong>Embedding queries</strong>{memoryQueries.map((query, index) => <code key={`${query}-${index}`}>{query}</code>)}</div> : <p className="memoryLookupUnavailable">Embedding queries were not recorded for this earlier result.</p>}
          {memoryLookup.items.map((item, index) => <div className="memoryLookupItem" key={`${item.date}-${index}`}><time>{item.date || 'Unknown date'}</time><span>{item.snippet}</span></div>)}
        </div>
      </details>
    </article>;
  }
  if (message.role === 'tool') return <ToolActivityView message={message}/>
  const participant = resolveParticipant(message, registry);
  const isRemoteAgent = participant.kind !== 'user' && participant.kind !== 'local-llm';
  const labelColor = isRemoteAgent ? PARTICIPANT_COLOR_VALUE[participant.color] : undefined;
  const isSquirl = message.role === 'assistant' && participant.kind === 'local-llm';
  return (
    <article id={`message-${message.id}`} className={`message ${message.role}${rewindCandidate ? ' rewindCandidate' : ''}${rewindSelected ? ' rewindSelected' : ''}`} data-participant={message.participantId ?? ''}>
      {showMeta && <div className="messageMeta">
        <span className={isSquirl ? 'squirlLabel' : undefined} style={labelColor ? { color: labelColor, fontWeight: 600 } : undefined}>
          {isSquirl && (
            <svg className="squirlAcorn" viewBox="0 0 16 16" aria-label="acorn" role="img">
              <path className="squirlAcornStem" d="M9.2 3.9c.1-1.2.8-2 2-2.6" />
              <path className="squirlAcornCap" d="M3.2 6.6c.6-2.4 2.6-3.8 5.3-3.8 2.6 0 4.5 1.4 5.1 3.8-2.9 1.3-7.4 1.3-10.4 0Z" />
              <path className="squirlAcornNut" d="M4.2 7.5c.5 3.9 2.1 6.4 4.3 6.4s3.8-2.5 4.2-6.4c-2.5.8-6 .8-8.5 0Z" />
            </svg>
          )}
          {messageLabel(message, registry)}
        </span>
        {message.role === 'assistant' && message.responseMeta && (
          <span className="responseMeta">
            {message.responseMeta.model}{message.responseMeta.effort ? ` · ${message.responseMeta.effort}` : ''}
          </span>
        )}
        {message.role === 'assistant' && message.isStreaming && <strong>streaming</strong>}
      </div>}
      <div className="messageBody">
        <MarkdownContent>{message.role === 'user' ? `${addressedParticipantLabel(message, registry)} ${displayContent}` : displayContent}</MarkdownContent>
      </div>
    </article>
  );
}

function ChatActivity({ label }: { label: string }) {
  return <div className="chatActivity" role="status" aria-live="polite">
    <svg className="chatActivityAcorn" viewBox="0 0 16 16" aria-hidden="true">
      <path className="squirlAcornStem" d="M9.2 3.9c.1-1.2.8-2 2-2.6" />
      <path className="squirlAcornCap" d="M3.2 6.6c.6-2.4 2.6-3.8 5.3-3.8 2.6 0 4.5 1.4 5.1 3.8-2.9 1.3-7.4 1.3-10.4 0Z" />
      <path className="squirlAcornNut" d="M4.2 7.5c.5 3.9 2.1 6.4 4.3 6.4s3.8-2.5 4.2-6.4c-2.5.8-6 .8-8.5 0Z" />
    </svg>
    <span>{label}</span>
  </div>;
}

function TurnView({ turn, showThinking, registry, rewindCandidateIds, selectedMessageId }: {
  turn: Message[]; showThinking: boolean; registry: Map<string, Participant>;
  rewindCandidateIds: Set<string>; selectedMessageId?: string;
}) {
  let metaShown = false;
  return <section className={`messageTurn ${turn[0]?.role === 'user' ? 'userTurn' : 'agentTurn'}`}>
    {turn.map((message) => {
      const showMeta = message.role !== 'tool' && !metaShown;
      if (showMeta) metaShown = true;
      return <MessageView key={message.id} message={message} showThinking={showThinking} registry={registry}
        showMeta={showMeta} rewindCandidate={rewindCandidateIds.has(message.id)} rewindSelected={selectedMessageId === message.id}/>;
    })}
  </section>;
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

function RoomRosterDropdown({ participants, onClose, onRename, onManage }: {
  participants: Participant[];
  onClose: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  onManage: () => void;
}) {
  const members = roomMembers(participants);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!dropdownRef.current?.contains(target) && !target.closest('.roomRosterControl')) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);
  return (
    <div className="roomRosterDropdown" ref={dropdownRef} role="dialog" aria-label="Agents in room">
        <header>
          <h2>◈ In this room ({members.length})</h2>
        </header>
        <div className="rosterList">
          {members.map((p) => {
            const isRemote = p.kind !== 'user' && p.kind !== 'local-llm';
            return (
              <div className="rosterRow" key={p.id}>
                <ParticipantIdentity participant={p} text={p.label} className="rosterName" />
                <span className="rosterHandle">{isRemote ? `@${p.id}` : 'local'}</span>
                <span className="rosterMeta">{p.status ?? 'ready'}{p.mode ? ` · ${p.mode}` : ''}</span>
                {isRemote && editingId !== p.id && (
                  <button className="chip rosterRename" onClick={() => { setEditingId(p.id); setName(p.label); }}>Rename</button>
                )}
                {isRemote && editingId === p.id && (
                  <form className="rosterRenameForm" onSubmit={(event) => {
                    event.preventDefault();
                    void onRename(p.id, name).then(() => setEditingId(null)).catch(() => undefined);
                  }}>
                    <input value={name} onChange={(event) => setName(event.target.value)} aria-label={`Rename @${p.id}`} autoFocus />
                    <button className="chip" type="submit">Save</button>
                    <button className="chip" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        <footer className="rosterFooter">
          <p className="hint">Use <code>/agent</code> to invite or manage agents.</p>
          <button className="primary rosterManage" type="button" onClick={onManage}>Add / manage agents</button>
        </footer>
    </div>
  );
}

function App() {
  const [uiState, setUiState] = useState<UiStateV1 | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [state, setState] = useState<AppState | null>(null);
  const [input, setInput] = useState('');
  const [activeSurface, setActiveSurface] = useState<CommandSurface | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [systemPrompt, setSystemPrompt] = useState('Loading system prompt…');
  const [evalHistory, setEvalHistory] = useState<HistoryEntry[]>([]);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalProgress, setEvalProgress] = useState<string | undefined>(undefined);
  const [evalError, setEvalError] = useState<string | undefined>(undefined);
  // Layer 3 chat-pane takeover
  const [evalRunActive, setEvalRunActive] = useState(false);
  const [evalRunTitle, setEvalRunTitle] = useState('');
  const [evalRunLines, setEvalRunLines] = useState<string[]>([]);
  const [evalRunDone, setEvalRunDone] = useState(false);
  const [evalRunSummary, setEvalRunSummary] = useState<JudgeSummary | undefined>(undefined);
  const [showThinking, setShowThinking] = useState(false);
  const [approval, setApproval] = useState<ToolApprovalRequest | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [recipientId, setRecipientId] = useState(SQUIRL_PARTICIPANT.id);
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [rewindCandidates, setRewindCandidates] = useState<Array<{ label: string; preview: string; messageId: string; messageIndex: number; retainedCount: number; removedCount: number; targetMessageId: string | null }> | null>(null);
  const [rewindIndex, setRewindIndex] = useState(0);
  const [rewindConfirming, setRewindConfirming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const savedChatScrollRef = useRef<ChatViewportSnapshot | null>(null);
  const stickToBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const profilePromptedRef = useRef(false);
  const uiStateRef = useRef<UiStateV1 | null>(null);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const chatVisible = !activeSurface && !evalRunActive;
  const finishActiveSurface = () => setActiveSurface(null);
  const finishEvalRun = () => setEvalRunActive(false);
  const updateUiState = useCallback((patch: UiStatePatch) => {
    setUiState((current) => current ? {
      ...current, ...patch,
      chat: { ...current.chat, ...patch.chat }, context: { ...current.context, ...patch.context },
      eval: { ...current.eval, ...patch.eval }, memory: { ...current.memory, ...patch.memory },
      model: { ...current.model, ...patch.model }, agent: { ...current.agent, ...patch.agent },
    } : current);
  }, []);
  const updateContextState = useCallback((next: UiStateV1['context']) => updateUiState({ context: next }), [updateUiState]);
  const updateEvalState = useCallback((next: UiStateV1['eval']) => updateUiState({ eval: next }), [updateUiState]);
  const updateMemoryState = useCallback((next: UiStateV1['memory']) => updateUiState({ memory: next }), [updateUiState]);
  const updateModelState = useCallback((next: UiStateV1['model']) => updateUiState({ model: next }), [updateUiState]);
  const updateAgentState = useCallback((next: UiStateV1['agent']) => updateUiState({ agent: next }), [updateUiState]);

  async function startRewindMode() {
    if (status.isStreaming) {
      pushToast('Cannot rewind while streaming.');
      return;
    }
    try {
      const result = await api<{ candidates: Array<{ label: string; preview: string; messageId: string; messageIndex: number; retainedCount: number; removedCount: number; targetMessageId: string | null }> }>('/api/rewind/candidates');
      if (result.candidates.length === 0) {
        pushToast('No previous user messages to rewind to.');
        return;
      }
      finishActiveSurface();
      setPaletteOpen(false);
      setRewindCandidates(result.candidates);
      setRewindIndex(result.candidates.length - 1);
      setRewindConfirming(false);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
    }
  }

  const openCommandSurface = (surface: CommandSurface) => {
    if (surface === 'rewind') {
      void startRewindMode();
      return;
    }
    const list = listRef.current;
    if (chatVisible && list && !savedChatScrollRef.current) {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      const listRect = list.getBoundingClientRect();
      const anchor = Array.from(list.querySelectorAll<HTMLElement>('.message[id^="message-"]'))
        .find((element) => element.getBoundingClientRect().bottom > listRect.top);
      savedChatScrollRef.current = {
        scrollTop: list.scrollTop,
        atLatest: distanceFromBottom < 32,
        ...(anchor ? {
          anchorMessageId: anchor.id.slice('message-'.length),
          anchorOffset: anchor.getBoundingClientRect().top - listRect.top,
        } : {}),
      };
    }
    setPaletteOpen(false);
    setActiveSurface(surface);
  };

  useEffect(() => {
    if (!state || !uiState || state.config.userProfile?.onboardingComplete || profilePromptedRef.current) return;
    profilePromptedRef.current = true;
    openCommandSurface('settings');
  }, [state, uiState]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    if (!uiState) return;
    const next = { ...uiState, activeSurface, theme, chat: { ...uiState.chat, draft: input, recipientId, showThinking } };
    uiStateRef.current = next;
    const timeout = window.setTimeout(() => {
      void api<UiStateV1>('/api/ui-state', { method: 'PATCH', body: JSON.stringify(next) }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [uiState, activeSurface, theme, input, recipientId, showThinking]);

  useEffect(() => {
    const flush = () => {
      if (!uiStateRef.current) return;
      void fetch(`${API_BASE}/api/ui-state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(uiStateRef.current), keepalive: true });
    };
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  const status = state?.status ?? defaultStatus();
  const messages = state?.messages ?? [];
  const participants = state?.participants ?? [USER_PARTICIPANT, SQUIRL_PARTICIPANT];
  const participantRegistry = useMemo(() => buildRegistry(participants), [participants]);
  const recipients = roomMembers(participants);
  const selectedRecipient = recipients.find((participant) => participant.id === recipientId) ?? SQUIRL_PARTICIPANT;
  useEffect(() => {
    if (!recipients.some((participant) => participant.id === recipientId)) setRecipientId(SQUIRL_PARTICIPANT.id);
  }, [participants, recipientId]);
  const lastMessage = messages[messages.length - 1];
  const waitingForAssistantMessage = status.isStreaming && !(
    lastMessage?.role === 'assistant' && lastMessage.isStreaming && lastMessage.content.length > 0
  );
  const activityLabel = chatActivityLabel(status.pipelineStatus);
  const scrollSignature = `${messages.length}:${lastMessage?.id ?? ''}:${lastMessage?.content.length ?? 0}`;

  const loadState = async () => {
    setState(await api<AppState>('/api/state'));
  };

  useEffect(() => {
    void Promise.all([loadState(), api<UiStateV1>('/api/ui-state')]).then(([, restored]) => {
      setUiState(restored);
      setTheme(restored.theme);
      setInput(restored.chat.draft);
      setActiveSurface(restored.activeSurface);
      setRecipientId(restored.chat.recipientId);
      setShowThinking(restored.chat.showThinking);
      savedChatScrollRef.current = restored.chat.viewport;
    }).catch(() => setUiState(defaultUiState()));
  }, []);
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

    const saved = savedChatScrollRef.current;
    if (saved) {
      const restore = () => {
        const listRect = list.getBoundingClientRect();
        const anchor = saved.anchorMessageId ? document.getElementById(`message-${saved.anchorMessageId}`) : null;
        list.scrollTop = restoredChatScrollTop(saved, {
          currentScrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          listTop: listRect.top,
          ...(anchor ? { anchorTop: anchor.getBoundingClientRect().top } : {}),
        });
        stickToBottomRef.current = saved.atLatest;
        setIsAtLatest(saved.atLatest);
      };
      restore();
      let nestedFrame = 0;
      const frame = window.requestAnimationFrame(() => {
        nestedFrame = window.requestAnimationFrame(() => {
          restore();
          savedChatScrollRef.current = null;
        });
      });
      return () => {
        window.cancelAnimationFrame(frame);
        if (nestedFrame) window.cancelAnimationFrame(nestedFrame);
      };
    }

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
  }, [chatVisible, scrollSignature, messages.length]);

  const handleMessageScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atLatest = distanceFromBottom < 32;
    stickToBottomRef.current = atLatest;
    setIsAtLatest(atLatest);
    const listRect = list.getBoundingClientRect();
    const anchor = Array.from(list.querySelectorAll<HTMLElement>('.message[id^="message-"]')).find((element) => element.getBoundingClientRect().bottom > listRect.top);
    updateUiState({ chat: { viewport: {
      scrollTop: list.scrollTop, atLatest,
      ...(anchor ? { anchorMessageId: anchor.id.slice('message-'.length), anchorOffset: anchor.getBoundingClientRect().top - listRect.top } : {}),
    } } });
  };

  const pushToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3500);
  };

  const sendMessage = async () => {
    const message = input.trim();
    if (!message || status.isStreaming) return;
    stickToBottomRef.current = true;
    setInput('');
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, recipientId }),
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
        if (event.type === 'open-command') openCommandSurface(event.surface);
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

  const addAgent = async (kind: AgentKind, options: { id?: string; model?: string; effort?: EffortLevel; cwd?: string }) => {
    try {
      const response = await api<{ state: AppState; agent: { id: string; label: string } }>('/api/agents/add', {
        method: 'POST',
        body: JSON.stringify({ kind, ...options }),
      });
      setState(response.state);
      setRecipientId(response.agent.id);
      pushToast(`${response.agent.label} joined the room.`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const stopAgent = async (id: string) => {
    try {
      const response = await api<{ state: AppState }>('/api/agents/stop', { method: 'POST', body: JSON.stringify({ id }) });
      setState(response.state);
      if (recipientId === id) setRecipientId(SQUIRL_PARTICIPANT.id);
      pushToast(`Stopped @${id}.`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
      throw error;
    }
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

  const loadEvalHistory = async () => {
    const result = await api<{ history: HistoryEntry[] }>('/api/eval/history');
    setEvalHistory(result.history);
  };

  useEffect(() => {
    if (activeSurface === 'eval') void loadEvalHistory();
  }, [activeSurface]);

  useEffect(() => {
    if (activeSurface !== 'system') return;
    void api<{ content: string }>('/api/system').then((result) => setSystemPrompt(result.content)).catch((error) => setSystemPrompt(error instanceof Error ? error.message : String(error)));
  }, [activeSurface]);

  const runEval = async (req: EvalRunRequest) => {
    // Layer 3 is slow (LLM calls per case) → take over the chat pane with a live log.
    const takeover = req.layer === 3;
    setEvalRunning(true);
    setEvalProgress('starting…');
    setEvalError(undefined);
    if (takeover) {
      setEvalRunActive(true);
      setEvalRunTitle(`eval · layer ${req.layer} (${req.mode})`);
      setEvalRunLines(['starting…']);
      setEvalRunDone(false);
      setEvalRunSummary(undefined);
    }
    try {
      const res = await fetch(`${API_BASE}/api/eval/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.body) throw new Error('No response stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as EvalEvent;
          if (event.type === 'progress') {
            const text = event.detail ?? event.stage;
            setEvalProgress(text);
            if (takeover) setEvalRunLines((prev) => [...prev, text]);
          } else if (event.type === 'result') {
            if (takeover) setEvalRunSummary(event.result.judge);
          } else if (event.type === 'error') {
            setEvalError(event.message);
          }
        }
      }
      await loadEvalHistory(); // reconcile with the canonical log
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setEvalRunning(false);
      setEvalProgress(undefined);
      if (takeover) setEvalRunDone(true);
    }
  };

  const closeActiveSurface = () => {
    if (activeSurface === 'settings' && !window.confirm('Close settings and discard any unsaved changes?')) return;
    finishActiveSurface();
  };

  // Escape unwinds one takeover level at a time: eval run → eval dashboard → chat.
  useEffect(() => {
    if (!evalRunActive && !activeSurface && !paletteOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (evalRunActive) {
        finishEvalRun();
      } else if (activeSurface) {
        closeActiveSurface();
      } else {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [evalRunActive, activeSurface, paletteOpen]);

  const activePanelView = useMemo(() => {
    if (!state) return null;
    if (activeSurface === 'eval') {
      return <EvalDashboard
        history={evalHistory}
        running={evalRunning}
        progress={evalProgress}
        error={evalError}
        monitorEnabled={!!state.config.eval?.monitor?.enabled}
        onRefresh={() => void loadEvalHistory()}
        onRun={(req) => void runEval(req)}
        onToggleMonitor={(enabled) => void saveConfig({
          ...state.config,
          eval: { ...state.config.eval, monitor: { ...state.config.eval?.monitor, enabled } },
        })}
        initialState={uiState?.eval ?? defaultUiState().eval}
        onStateChange={updateEvalState}
      />;
    }
    if (activeSurface === 'settings') return <SettingsWizard state={state} onSave={saveConfig} onClose={closeActiveSurface} onSaved={finishActiveSurface} onDetectLocal={detectLocal} />;
    if (activeSurface === 'model') return <ModelPanel current={status.selectedModel} onSelect={selectModel} onDetect={detectLocal} initialState={uiState?.model ?? defaultUiState().model} onStateChange={updateModelState} />;
    if (activeSurface === 'memory') {
      return <ImportPanel
        initialState={uiState?.memory ?? defaultUiState().memory}
        onStateChange={updateMemoryState}
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
    // 'context' is rendered as a chat-pane takeover (see ContextView), not in the right rail.
    if (activeSurface === 'agent') return <AgentPanel participants={participants} defaultCwd={state.status.workingDir} onAdd={addAgent} onStop={stopAgent} initialState={uiState?.agent ?? defaultUiState().agent} onStateChange={updateAgentState}/>;
    if (activeSurface === 'room') return <div className="roomSurface"><h3>Participants</h3>{roomMembers(participants).map((p) => <div className="rosterRow" key={p.id}><ParticipantIdentity participant={p} text={p.label} className="rosterName"/><code>{p.kind === 'user' || p.kind === 'local-llm' ? 'local' : `@${p.id}`}</code><span>{p.status ?? 'ready'}</span></div>)}</div>;
    if (activeSurface === 'system') return <pre className="systemPromptView">{systemPrompt}</pre>;
    if (activeSurface === 'help') return <div className="helpGrid">{state.commands.map((command) => <button key={command.name} onClick={() => { const surface = resolveCommandSurface(command); if (surface) openCommandSurface(surface); }}><code>{command.usage}</code><span>{command.description}</span></button>)}</div>;
    return null;
  }, [activeSurface, state, status.selectedModel, approval, evalHistory, evalRunning, evalProgress, evalError, participants, systemPrompt, recipientId, uiState, updateEvalState, updateMemoryState, updateModelState, updateAgentState]);

  const paletteMatches = useMemo(() => {
    const needle = input.slice(1).toLowerCase();
    return filterCommandPalette(state?.commands ?? [], input);
  }, [input, state?.commands]);
  const chooseCommand = (command: CommandDescriptor) => {
    setPaletteOpen(false);
    setPaletteIndex(0);
    const surface = resolveCommandSurface(command);
    if (surface) {
      setInput('');
      openCommandSurface(surface);
    } else {
      setInput(commandSelectionValue(command) ?? '');
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
  };

  const selectedRewindCandidate = rewindCandidates?.[Math.min(rewindIndex, Math.max(0, (rewindCandidates?.length ?? 1) - 1))];
  const rewindCandidateIds = useMemo(() => new Set(rewindCandidates?.map((candidate) => candidate.messageId) ?? []), [rewindCandidates]);

  const cancelRewindMode = () => {
    setRewindCandidates(null);
    setRewindConfirming(false);
    composerRef.current?.focus();
  };

  const applySelectedRewind = async () => {
    if (!selectedRewindCandidate) return;
    try {
      setState(await api<AppState>('/api/rewind', { method: 'POST', body: JSON.stringify(selectedRewindCandidate) }));
      setRewindCandidates(null);
      setRewindConfirming(false);
      stickToBottomRef.current = true;
      pushToast(`Rewound ${selectedRewindCandidate.removedCount} message${selectedRewindCandidate.removedCount === 1 ? '' : 's'}.`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!selectedRewindCandidate) return;
    document.getElementById(`message-${selectedRewindCandidate.messageId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedRewindCandidate?.messageId]);

  useEffect(() => {
    if (!rewindCandidates?.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (rewindConfirming) {
        if (event.key === 'Enter' || event.key.toLowerCase() === 'y') {
          event.preventDefault();
          void applySelectedRewind();
        } else if (event.key === 'Escape' || event.key.toLowerCase() === 'n') {
          event.preventDefault();
          cancelRewindMode();
        }
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        setRewindIndex((index) => Math.max(0, Math.min(rewindCandidates.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        setRewindConfirming(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRewindMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rewindCandidates, rewindConfirming, selectedRewindCandidate]);

  if (!state || !uiState) return (
    <main className="appShell loadingScreen" data-theme={theme}>
      <div className="emptyState" role="status" aria-label="Loading Squirl">
        <svg className="loadingAcorn" viewBox="0 0 16 16" aria-hidden="true">
          <path className="squirlAcornStem" d="M9.2 3.9c.1-1.2.8-2 2-2.6" />
          <path className="squirlAcornCap" d="M3.2 6.6c.6-2.4 2.6-3.8 5.3-3.8 2.6 0 4.5 1.4 5.1 3.8-2.9 1.3-7.4 1.3-10.4 0Z" />
          <path className="squirlAcornNut" d="M4.2 7.5c.5 3.9 2.1 6.4 4.3 6.4s3.8-2.5 4.2-6.4c-2.5.8-6 .8-8.5 0Z" />
        </svg>
      </div>
    </main>
  );

  return (
    <main className="appShell" data-theme={theme}>
      <aside className="leftRail">
        <div className="brand">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo-light.png'}
            alt="Squirl"
          />
          <span>{status.workingDir || 'loading...'}</span>
        </div>
        <button
          className="themeToggle"
          type="button"
          onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        {state?.health && state.health.entries.length > 0 && (
          <div className="healthLights">
            {state.health.entries.map((h) => (
              <div key={h.id} className="healthRow" title={h.detail ?? h.state}>
                <span className={`healthDot ${h.state}`} />
                <span className="healthLabel">{h.label}</span>
              </div>
            ))}
          </div>
        )}
        <RoomSidebarRoster
          participants={participants}
          loadPreview={async (participantId, signal) => (
            await api<{ preview: ParticipantContextPreview }>(`/api/participants/${encodeURIComponent(participantId)}/context-preview`, { signal })
          ).preview}
        />
        <div className="telemetry">
          <span>model</span><strong>{status.modelDisplay}</strong>
          <span>context</span><strong>{formatTokens(status.tokenCount)} / {status.contextWindow == null ? '?' : formatTokens(status.contextWindow)}</strong>
          <span>speed</span><strong>{status.tokensPerSecond} t/s</strong>
          <span>memory</span><strong>{status.indexEnabled ? status.storeName || 'enabled' : 'off'}</strong>
        </div>
      </aside>

      <section className={chatVisible ? 'chatPane' : 'chatPane chatPaneTakeover'}>
        {evalRunActive ? (
          <EvalRunView
            title={evalRunTitle}
            lines={evalRunLines}
            done={evalRunDone}
            error={evalError}
            summary={evalRunSummary}
            onClose={finishEvalRun}
          />
        ) : activeSurface === 'context' ? (
          <ContextView
            breakdown={status.contextBreakdown}
            window={status.contextWindow}
            files={state?.contextFiles ?? []}
            onAdd={async (path) => setState(await api<AppState>('/api/context/add', { method: 'POST', body: JSON.stringify({ path }) }))}
            onRemove={async (path) => setState(await api<AppState>('/api/context/remove', { method: 'POST', body: JSON.stringify({ path }) }))}
            onClear={async () => setState(await api<AppState>('/api/context/clear', { method: 'POST' }))}
            onSearch={async (q) => (await api<{ files: string[] }>(`/api/files?q=${encodeURIComponent(q)}`)).files}
            onLoadSnapshot={async () => (await api<{ snapshot: import('./types.js').ContextSnapshot | null }>('/api/context/snapshot')).snapshot}
            onClose={closeActiveSurface}
            initialState={uiState?.context ?? defaultUiState().context}
            onStateChange={updateContextState}
          />
        ) : activeSurface ? (
          <SurfaceFrame title={activeSurface} onClose={closeActiveSurface}>
            {activePanelView}
          </SurfaceFrame>
        ) : (
        <>
        <header className="topBar">
          <div>
            <strong>{status.pipelineStatus ? `${status.pipelineStatus.stage}${status.pipelineStatus.detail ? ` · ${status.pipelineStatus.detail}` : ''}` : status.toolStatus || 'ready'}</strong>
            <span>{status.embedderName || 'index not configured'}</span>
          </div>
          <div className="topActions">
            <div className="roomRosterControl">
              <button
                className="chip"
                onClick={() => setRosterOpen((open) => !open)}
                title="Show who is in the room"
                aria-expanded={rosterOpen}
                aria-haspopup="dialog"
              >
                ◈ {roomMembers(participants).length} in room
              </button>
              {rosterOpen && <RoomRosterDropdown
                participants={participants}
                onClose={() => setRosterOpen(false)}
                onManage={() => {
                  setRosterOpen(false);
                  openCommandSurface('agent');
                }}
                onRename={async (id, name) => {
                  try {
                    const response = await api<{ state: AppState; agent: { id: string } }>('/api/agents/rename', { method: 'POST', body: JSON.stringify({ id, name }) });
                    setState(response.state);
                    if (recipientId === id) setRecipientId(response.agent.id);
                  } catch (error) {
                    pushToast(error instanceof Error ? error.message : String(error));
                    throw error;
                  }
                }}
              />}
            </div>
            <label className="check">
              <input type="checkbox" checked={showThinking} onChange={(event) => setShowThinking(event.target.checked)} />
              thinking
            </label>
            {status.isStreaming && <button className="danger" onClick={() => void api('/api/cancel', { method: 'POST' }).then(loadState)}>Cancel</button>}
          </div>
        </header>

        <div className={`messageList${rewindCandidates ? ' rewindMode' : ''}`} ref={listRef} onScroll={handleMessageScroll}>
          {messages.length === 0 ? (
            <div className="emptyState">
              <h2>Start a Squirl session</h2>
              <p>Ask a question, attach files from Context, or import ChatGPT history from Memory.</p>
            </div>
          ) : groupMessageTurns(messages).map((turn) => <TurnView key={turn.key} turn={turn.messages} showThinking={showThinking} registry={participantRegistry} rewindCandidateIds={rewindCandidateIds} selectedMessageId={selectedRewindCandidate?.messageId}/>)}
          {waitingForAssistantMessage && <ChatActivity label={activityLabel}/>}
          <div ref={bottomRef} className="bottomSentinel" aria-hidden="true" />
          {!isAtLatest && (
            <button className="latestButton" onClick={() => scrollToLatest('smooth')}>
              Latest
            </button>
          )}
        </div>

        <footer className={`composer${status.isStreaming ? ' composerActive' : ''}${rewindCandidates ? ' rewindComposer' : ''}`} onKeyDownCapture={(event) => {
          if (!paletteOpen) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setPaletteOpen(false);
            return;
          }
          if (paletteMatches.length === 0) return;
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            setPaletteIndex((index) => moveCommandSelection(index, event.key === 'ArrowUp' ? -1 : 1, paletteMatches.length));
            return;
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            event.stopPropagation();
            chooseCommand(paletteMatches[Math.min(paletteIndex, paletteMatches.length - 1)]!);
          }
        }}>
          {rewindCandidates && selectedRewindCandidate && <div className="rewindBar">
            <strong>Rewind</strong>
            <span>{rewindIndex + 1}/{rewindCandidates.length}</span>
            <span className="rewindBarTarget">{selectedRewindCandidate.preview}</span>
            <span>remove {selectedRewindCandidate.removedCount}</span>
            {rewindConfirming ? <><span className="rewindWarning">Remove later messages?</span><button className="danger" onClick={() => void applySelectedRewind()}>Rewind</button><button onClick={cancelRewindMode}>Cancel</button></> : <><span className="hint">↑↓ select · Enter confirm · Esc cancel</span><button onClick={() => setRewindConfirming(true)}>Select</button></>}
          </div>}
          {paletteOpen && state && (
            <CommandPaletteView commands={state.commands} query={input} selected={paletteIndex} onSelected={setPaletteIndex} onChoose={chooseCommand}/>
          )}
          <div className="recipientPicker">
            <button
              className="recipientButton"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={recipientMenuOpen}
              onClick={() => setRecipientMenuOpen((open) => !open)}
            >
              <ParticipantIdentity participant={selectedRecipient} text={`@${recipientId}`} />
              <span aria-hidden="true">▾</span>
            </button>
            {recipientMenuOpen && (
              <div className="recipientMenu" role="listbox" aria-label="Message recipient">
                {recipients.map((participant) => (
                  <button
                    key={participant.id}
                    type="button"
                    role="option"
                    aria-selected={participant.id === recipientId}
                    className={participant.id === recipientId ? 'selected' : ''}
                    onClick={() => { setRecipientId(participant.id); setRecipientMenuOpen(false); }}
                  >
                    <ParticipantIdentity participant={participant} text={`@${participant.id}`} />
                    <small>{participant.status ?? 'ready'}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <textarea
            ref={composerRef}
            aria-controls={paletteOpen ? 'slash-command-list' : undefined}
            aria-activedescendant={paletteOpen && paletteMatches[paletteIndex] ? `slash-command-${paletteMatches[paletteIndex]!.name}` : undefined}
            aria-autocomplete="list"
            aria-expanded={paletteOpen}
            value={input}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              const shouldSuggest = shouldShowCommandPalette(value);
              setPaletteOpen(shouldSuggest);
              if (shouldSuggest) setPaletteIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Type a message, slash command, or @file reference..."
          />
          {status.isStreaming && <div className="composerProgress" role="progressbar" aria-label={activityLabel}><span /></div>}
          <button className="primary" disabled={status.isStreaming} onClick={() => void sendMessage()}>Send</button>
        </footer>
        </>
        )}
      </section>

      {approval && <ApprovalModal request={approval} onRespond={approve} />}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
