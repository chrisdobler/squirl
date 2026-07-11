import type { AgentKind } from '../agents/types.js';
import type { CommandSurface } from '../commands/registry.js';
import type { EffortLevel } from '../types.js';

export const UI_STATE_VERSION = 1 as const;

const SURFACES: CommandSurface[] = ['settings', 'model', 'context', 'memory', 'eval', 'rewind', 'room', 'agent', 'system', 'help'];
const RESTORABLE_SURFACES = new Set<CommandSurface>(SURFACES.filter((surface) => surface !== 'rewind' && surface !== 'settings'));

export interface UiStateV1 {
  version: typeof UI_STATE_VERSION;
  activeSurface: CommandSurface | null;
  theme: 'light' | 'dark';
  chat: {
    draft: string;
    recipientId: string;
    showThinking: boolean;
    viewport: { scrollTop: number; atLatest: boolean; anchorMessageId?: string; anchorOffset?: number } | null;
  };
  context: { mode: 'explorer' | 'files'; query: string; activeDiscIndex: number | null };
  eval: { selectedKey: string; hiddenMetrics: string[]; layer: 1 | 2 | 3; mode: 'frozen' | 'live'; label: string };
  memory: { importPath: string; recallQuery: string };
  model: { localUrl: string; manualModel: string };
  agent: { kind: AgentKind; id: string; model: string; effort: EffortLevel | ''; cwd: string };
}

export type UiStatePatch = Partial<Omit<UiStateV1, 'version' | 'chat' | 'context' | 'eval' | 'memory' | 'model' | 'agent'>> & {
  chat?: Partial<UiStateV1['chat']>;
  context?: Partial<UiStateV1['context']>;
  eval?: Partial<UiStateV1['eval']>;
  memory?: Partial<UiStateV1['memory']>;
  model?: Partial<UiStateV1['model']>;
  agent?: Partial<UiStateV1['agent']>;
};

export function defaultUiState(): UiStateV1 {
  return {
    version: UI_STATE_VERSION,
    activeSurface: null,
    theme: 'dark',
    chat: { draft: '', recipientId: 'squirl', showThinking: false, viewport: null },
    context: { mode: 'explorer', query: '', activeDiscIndex: null },
    eval: { selectedKey: '', hiddenMetrics: [], layer: 1, mode: 'frozen', label: '' },
    memory: { importPath: '', recallQuery: '' },
    model: { localUrl: 'http://localhost:8000/v1', manualModel: '' },
    agent: { kind: 'claude-code', id: '', model: '', effort: '', cwd: '' },
  };
}

const string = (value: unknown, fallback: string): string => typeof value === 'string' ? value : fallback;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function normalizeUiState(value: unknown): UiStateV1 {
  const defaults = defaultUiState();
  const root = record(value);
  const chat = record(root.chat);
  const context = record(root.context);
  const evalState = record(root.eval);
  const memory = record(root.memory);
  const model = record(root.model);
  const agent = record(root.agent);
  const viewport = record(chat.viewport);
  const surface = RESTORABLE_SURFACES.has(root.activeSurface as CommandSurface) ? root.activeSurface as CommandSurface : null;
  const hiddenMetrics = Array.isArray(evalState.hiddenMetrics) ? evalState.hiddenMetrics.filter((item): item is string => typeof item === 'string') : [];
  const viewportValid = Number.isFinite(viewport.scrollTop) && typeof viewport.atLatest === 'boolean';
  return {
    version: UI_STATE_VERSION,
    activeSurface: surface,
    theme: root.theme === 'light' ? 'light' : 'dark',
    chat: {
      draft: string(chat.draft, ''),
      recipientId: string(chat.recipientId, 'squirl'),
      showThinking: chat.showThinking === true,
      viewport: viewportValid ? {
        scrollTop: Math.max(0, viewport.scrollTop as number),
        atLatest: viewport.atLatest as boolean,
        ...(typeof viewport.anchorMessageId === 'string' ? { anchorMessageId: viewport.anchorMessageId } : {}),
        ...(Number.isFinite(viewport.anchorOffset) ? { anchorOffset: viewport.anchorOffset as number } : {}),
      } : null,
    },
    context: {
      mode: context.mode === 'files' ? 'files' : 'explorer',
      query: string(context.query, ''),
      activeDiscIndex: Number.isInteger(context.activeDiscIndex) && (context.activeDiscIndex as number) >= 0 ? context.activeDiscIndex as number : null,
    },
    eval: {
      selectedKey: string(evalState.selectedKey, ''),
      hiddenMetrics,
      layer: evalState.layer === 2 || evalState.layer === 3 ? evalState.layer : 1,
      mode: evalState.mode === 'live' ? 'live' : 'frozen',
      label: string(evalState.label, ''),
    },
    memory: { importPath: string(memory.importPath, ''), recallQuery: string(memory.recallQuery, '') },
    model: { localUrl: string(model.localUrl, defaults.model.localUrl), manualModel: string(model.manualModel, '') },
    agent: {
      kind: agent.kind === 'codex' ? 'codex' : 'claude-code',
      id: string(agent.id, ''), model: string(agent.model, ''),
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(agent.effort)) ? agent.effort as EffortLevel : '',
      cwd: string(agent.cwd, ''),
    },
  };
}

export function mergeUiState(current: UiStateV1, patch: UiStatePatch): UiStateV1 {
  return normalizeUiState({
    ...current, ...patch, version: UI_STATE_VERSION,
    chat: { ...current.chat, ...patch.chat },
    context: { ...current.context, ...patch.context },
    eval: { ...current.eval, ...patch.eval },
    memory: { ...current.memory, ...patch.memory },
    model: { ...current.model, ...patch.model },
    agent: { ...current.agent, ...patch.agent },
  });
}
