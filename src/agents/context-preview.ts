import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { computeContextDiscs, type DiscKind } from '../context/context-discs.js';
import type { ContextSnapshot } from '../context/context-snapshot.js';
import { estimateTokens } from '../context/token-estimator.js';
import type { AgentKind } from './types.js';

export interface ContextPreviewBuckets {
  system: number;
  memory: number;
  files: number;
  messages: number;
}

export type ContextPreviewFidelity = 'exact' | 'preview' | 'inspected' | 'inspected-estimate' | 'unavailable';
export type ContextPreviewSource = 'squirl-request' | 'claude-session' | 'codex-session';
export type ContextPreviewMatrixMode = 'categorized' | 'usage';

/** Sanitized context data safe to return to the renderer. It intentionally contains no raw context text or paths. */
export interface ParticipantContextPreview {
  participantId: string;
  modelId: string | null;
  source: ContextPreviewSource;
  fidelity: ContextPreviewFidelity;
  matrixMode: ContextPreviewMatrixMode;
  capturedAt: string | null;
  usedTokens: number | null;
  contextWindow: number | null;
  buckets: ContextPreviewBuckets;
  discs: DiscKind[];
  unavailableReason?: string;
}

export interface AgentContextTelemetry {
  participantId: string;
  sessionId?: string;
  modelId?: string;
  inputTokens?: number;
  contextWindow?: number;
  capturedAt?: string;
}

interface InspectedContext {
  buckets: ContextPreviewBuckets;
  modelId?: string;
  inputTokens?: number;
  contextWindow?: number;
  capturedAt?: string;
}

export interface ContextArtifactRoots {
  claudeProjects: string;
  codexSessions: string;
}

const EMPTY_BUCKETS: ContextPreviewBuckets = { system: 0, memory: 0, files: 0, messages: 0 };
const MEMORY_PATTERN = /(?:recalled memory|memory citation|<oai-mem-citation>|(?:^|\/)MEMORY\.md)/i;
const FILE_TOOL_PATTERN = /^(?:read|read_file|readfile|glob|grep|view_image|viewimage|list_files|listfiles)$/i;

function jsonLines(content: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed as Record<string, unknown>);
    } catch {
      // Session files can be read while the CLI is appending a line. Ignore incomplete/unknown rows.
    }
  }
  return entries;
}

function tokenWeight(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text ? Math.max(1, estimateTokens(text)) : 0;
}

function addBucket(buckets: ContextPreviewBuckets, kind: keyof ContextPreviewBuckets, value: unknown): void {
  buckets[kind] += tokenWeight(value);
}

function contentLooksLikeMemory(value: unknown): boolean {
  if (value == null) return false;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return MEMORY_PATTERN.test(text);
}

function claudeContent(entry: Record<string, unknown>): unknown {
  const message = entry.message as Record<string, unknown> | undefined;
  return message?.content ?? entry.content ?? entry.attachment ?? '';
}

function claudeToolNames(entry: Record<string, unknown>): string[] {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const record = block as Record<string, unknown>;
    return record.type === 'tool_use' && typeof record.name === 'string' ? [record.name] : [];
  });
}

function activeClaudeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const entry of entries) if (typeof entry.uuid === 'string') byUuid.set(entry.uuid, entry);
  const lastPrompt = [...entries].reverse().find((entry) => entry.type === 'last-prompt' && typeof entry.leafUuid === 'string');
  let leaf = typeof lastPrompt?.leafUuid === 'string'
    ? lastPrompt.leafUuid
    : [...entries].reverse().find((entry) => typeof entry.uuid === 'string')?.uuid as string | undefined;
  if (!leaf) return entries.filter((entry) => entry.isSidechain !== true);

  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const entry = byUuid.get(leaf);
    if (!entry) break;
    if (entry.isSidechain !== true) chain.push(entry);
    leaf = typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined;
  }
  chain.reverse();
  let compactIndex = -1;
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index]!;
    const type = String(entry.type ?? '');
    const subtype = String(entry.subtype ?? '');
    if (entry.isCompactSummary === true || /compact/i.test(type) || /compact/i.test(subtype)) {
      compactIndex = index;
      break;
    }
  }
  return compactIndex >= 0 ? chain.slice(compactIndex) : chain;
}

export function inspectClaudeSession(content: string): InspectedContext | null {
  const entries = jsonLines(content);
  if (entries.length === 0) return null;
  const active = activeClaudeEntries(entries);
  const buckets = { ...EMPTY_BUCKETS };
  const toolNameByUseId = new Map<string, string>();
  let modelId: string | undefined;
  let inputTokens: number | undefined;
  let capturedAt: string | undefined;
  let finalAssistantIndex = -1;
  let finalAssistantMessageId: string | undefined;
  for (let index = active.length - 1; index >= 0; index--) {
    if (active[index]!.type === 'assistant') {
      finalAssistantIndex = index;
      const message = active[index]!.message as Record<string, unknown> | undefined;
      if (typeof message?.id === 'string') finalAssistantMessageId = message.id;
      break;
    }
  }

  for (let entryIndex = 0; entryIndex < active.length; entryIndex++) {
    const entry = active[entryIndex]!;
    const value = claudeContent(entry);
    if (typeof entry.timestamp === 'string') capturedAt = entry.timestamp;
    const message = entry.message as Record<string, unknown> | undefined;
    if (typeof message?.model === 'string') modelId = message.model;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (usage) {
      const input = Number(usage.input_tokens ?? 0);
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
      const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
      const reported = input + cacheRead + cacheCreation;
      if (reported > 0) inputTokens = reported;
    }
    for (const name of claudeToolNames(entry)) {
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).name === name) {
          const id = (block as Record<string, unknown>).id;
          if (typeof id === 'string') toolNameByUseId.set(id, name);
        }
      }
    }

    if (contentLooksLikeMemory(value)) {
      addBucket(buckets, 'memory', value);
      continue;
    }
    if (entry.type === 'file-history-snapshot') {
      addBucket(buckets, 'files', entry.snapshot ?? value);
      continue;
    }
    if (entry.type === 'attachment' || entry.type === 'system') {
      const attachment = entry.attachment as Record<string, unknown> | undefined;
      const attachmentType = String(attachment?.type ?? entry.subtype ?? '');
      if (/file|image/i.test(attachmentType)) addBucket(buckets, 'files', value);
      else addBucket(buckets, 'system', value);
      continue;
    }
    if (entry.type === 'user' && Array.isArray(message?.content)) {
      const toolResult = message.content.find((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result') as Record<string, unknown> | undefined;
      const toolName = typeof toolResult?.tool_use_id === 'string' ? toolNameByUseId.get(toolResult.tool_use_id) : undefined;
      addBucket(buckets, toolName && FILE_TOOL_PATTERN.test(toolName) ? 'files' : 'messages', value);
      continue;
    }
    const isCompletedResponse = entry.type === 'assistant'
      && (entryIndex === finalAssistantIndex || (finalAssistantMessageId != null && message?.id === finalAssistantMessageId));
    if (entry.type === 'user' || (entry.type === 'assistant' && !isCompletedResponse)) addBucket(buckets, 'messages', value);
  }
  return { buckets, modelId, inputTokens, capturedAt };
}

function codexText(entry: Record<string, unknown>): unknown {
  const payload = entry.payload as Record<string, unknown> | undefined;
  return payload?.content ?? payload?.message ?? payload?.output ?? payload?.summary ?? '';
}

export function inspectCodexSession(content: string): InspectedContext | null {
  const entries = jsonLines(content);
  if (entries.length === 0) return null;
  const buckets = { ...EMPTY_BUCKETS };
  const toolNameByCallId = new Map<string, string>();
  let latestContextIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]!.type === 'turn_context') {
      latestContextIndex = index;
      break;
    }
  }
  const latestContext = latestContextIndex >= 0 ? entries[latestContextIndex]!.payload as Record<string, unknown> : undefined;
  const summary = latestContext?.summary;
  let modelId = typeof latestContext?.model === 'string' ? latestContext.model : undefined;
  let inputTokens: number | undefined;
  let contextWindow: number | undefined;
  let capturedAt: string | undefined;
  let finalAssistantIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const payload = entries[index]!.payload as Record<string, unknown> | undefined;
    if (entries[index]!.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant') {
      finalAssistantIndex = index;
      break;
    }
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (typeof entry.timestamp === 'string') capturedAt = entry.timestamp;
    if (entry.type === 'session_meta') {
      if (!modelId && typeof payload?.model === 'string') modelId = payload.model;
      if (typeof payload?.context_window === 'number') contextWindow = payload.context_window;
      addBucket(buckets, 'system', { base_instructions: payload?.base_instructions, dynamic_tools: payload?.dynamic_tools });
      continue;
    }
    if (entry.type === 'turn_context') {
      if (index === latestContextIndex) {
        addBucket(buckets, 'system', {
          approval_policy: payload?.approval_policy,
          collaboration_mode: payload?.collaboration_mode,
          sandbox_policy: payload?.sandbox_policy,
          personality: payload?.personality,
        });
        if (summary) addBucket(buckets, contentLooksLikeMemory(summary) ? 'memory' : 'messages', summary);
      }
      continue;
    }
    if (entry.type === 'event_msg' && payload?.type === 'token_count') {
      const info = payload.info as Record<string, unknown> | undefined;
      const last = info?.last_token_usage as Record<string, unknown> | undefined;
      const used = Number(last?.input_tokens ?? 0);
      if (used > 0) inputTokens = used;
      const window = Number(info?.model_context_window ?? 0);
      if (window > 0) contextWindow = window;
      continue;
    }
    if (entry.type !== 'response_item') continue;
    if (summary && index < latestContextIndex) {
      if (payload?.type === 'message' && payload.role === 'developer') addBucket(buckets, 'system', codexText(entry));
      continue;
    }
    if (payload?.type === 'message') {
      const value = codexText(entry);
      const kind = payload.role === 'developer' ? 'system' : contentLooksLikeMemory(value) ? 'memory' : 'messages';
      if (index !== finalAssistantIndex) addBucket(buckets, kind, value);
    } else if (typeof payload?.type === 'string' && /tool_call$|function_call$/.test(payload.type)) {
      const callId = payload.call_id;
      const name = payload.name;
      if (typeof callId === 'string' && typeof name === 'string') toolNameByCallId.set(callId, name);
      addBucket(buckets, 'messages', { name, input: payload.input ?? payload.arguments });
    } else if (typeof payload?.type === 'string' && /tool_call_output$|function_call_output$/.test(payload.type)) {
      const name = typeof payload.call_id === 'string' ? toolNameByCallId.get(payload.call_id) : undefined;
      const value = payload.output;
      addBucket(buckets, name && FILE_TOOL_PATTERN.test(name) ? 'files' : contentLooksLikeMemory(value) ? 'memory' : 'messages', value);
    }
  }
  return { buckets, modelId, inputTokens, contextWindow, capturedAt };
}

function findFile(root: string, predicate: (name: string) => boolean, maxDepth = 4): string | null {
  if (!existsSync(root)) return null;
  const walk = (directory: string, depth: number): string | null => {
    if (depth > maxDepth) return null;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && predicate(entry.name)) return path;
      if (entry.isDirectory()) {
        const found = walk(path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root, 0);
}

function normalizedBuckets(buckets: ContextPreviewBuckets, usedTokens: number): ContextPreviewBuckets {
  const weight = buckets.system + buckets.memory + buckets.files + buckets.messages;
  if (!(weight > 0) || !(usedTokens > 0)) return { ...EMPTY_BUCKETS };
  const result: ContextPreviewBuckets = {
    system: Math.floor((buckets.system / weight) * usedTokens),
    memory: Math.floor((buckets.memory / weight) * usedTokens),
    files: Math.floor((buckets.files / weight) * usedTokens),
    messages: Math.floor((buckets.messages / weight) * usedTokens),
  };
  result.messages += usedTokens - (result.system + result.memory + result.files + result.messages);
  return result;
}

export function unavailableContextPreview(participantId: string, source: ContextPreviewSource, reason: string, modelId?: string): ParticipantContextPreview {
  return {
    participantId,
    modelId: modelId ?? null,
    source,
    fidelity: 'unavailable',
    matrixMode: source === 'codex-session' ? 'usage' : 'categorized',
    capturedAt: null,
    usedTokens: null,
    contextWindow: null,
    buckets: { ...EMPTY_BUCKETS },
    discs: computeContextDiscs(EMPTY_BUCKETS, 0),
    unavailableReason: reason,
  };
}

export function contextPreviewFromSnapshot(participantId: string, snapshot: ContextSnapshot): ParticipantContextPreview {
  const buckets = { ...EMPTY_BUCKETS };
  for (const section of snapshot.sections) buckets[section.category] += section.approximateTokens;
  return {
    participantId,
    modelId: snapshot.modelId,
    source: 'squirl-request',
    fidelity: snapshot.origin,
    matrixMode: 'categorized',
    capturedAt: snapshot.capturedAt,
    usedTokens: snapshot.approximateTokens,
    contextWindow: snapshot.contextWindow,
    buckets,
    discs: snapshot.discs.map((disc) => disc.kind),
  };
}

export function defaultContextArtifactRoots(): ContextArtifactRoots {
  return {
    claudeProjects: join(homedir(), '.claude', 'projects'),
    codexSessions: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
  };
}

export function inspectParticipantContext(kind: AgentKind, telemetry: AgentContextTelemetry, roots = defaultContextArtifactRoots()): ParticipantContextPreview {
  const source: ContextPreviewSource = kind === 'claude-code' ? 'claude-session' : 'codex-session';
  const codexUsageFallback = (): ParticipantContextPreview | null => {
    if (kind !== 'codex' || telemetry.inputTokens == null) return null;
    const buckets = { ...EMPTY_BUCKETS, messages: telemetry.inputTokens };
    return {
      participantId: telemetry.participantId,
      modelId: telemetry.modelId ?? null,
      source,
      fidelity: 'preview',
      matrixMode: 'usage',
      capturedAt: telemetry.capturedAt ?? null,
      usedTokens: telemetry.inputTokens,
      contextWindow: telemetry.contextWindow ?? null,
      buckets,
      discs: computeContextDiscs(buckets, telemetry.contextWindow ?? 0),
    };
  };
  if (!telemetry.sessionId) return codexUsageFallback() ?? unavailableContextPreview(telemetry.participantId, source, 'No session context is available until this agent has started a turn.', telemetry.modelId);
  const file = kind === 'claude-code'
    ? findFile(roots.claudeProjects, (name) => name === `${telemetry.sessionId}.jsonl`, 2)
    : findFile(roots.codexSessions, (name) => name.endsWith(`${telemetry.sessionId}.jsonl`), 4);
  if (!file) return codexUsageFallback() ?? unavailableContextPreview(telemetry.participantId, source, 'The local CLI session artifact is not available yet.', telemetry.modelId);
  let inspected: InspectedContext | null;
  try {
    const content = readFileSync(file, 'utf-8');
    inspected = kind === 'claude-code' ? inspectClaudeSession(content) : inspectCodexSession(content);
  } catch {
    inspected = null;
  }
  if (!inspected) return codexUsageFallback() ?? unavailableContextPreview(telemetry.participantId, source, 'The local CLI session artifact could not be inspected.', telemetry.modelId);

  const estimated = inspected.buckets.system + inspected.buckets.memory + inspected.buckets.files + inspected.buckets.messages;
  const authoritativeUsed = telemetry.inputTokens ?? inspected.inputTokens;
  const usedTokens = authoritativeUsed ?? estimated;
  const contextWindow = telemetry.contextWindow ?? inspected.contextWindow ?? null;
  const buckets = normalizedBuckets(inspected.buckets, usedTokens);
  return {
    participantId: telemetry.participantId,
    modelId: telemetry.modelId ?? inspected.modelId ?? null,
    source,
    fidelity: authoritativeUsed == null ? 'inspected-estimate' : 'inspected',
    matrixMode: kind === 'codex' ? 'usage' : 'categorized',
    capturedAt: telemetry.capturedAt ?? inspected.capturedAt ?? null,
    usedTokens,
    contextWindow,
    buckets,
    discs: computeContextDiscs(buckets, contextWindow ?? 0),
  };
}
