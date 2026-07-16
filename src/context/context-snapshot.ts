import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { estimateMessagesTokens, estimateTokens } from './token-estimator.js';
import type { DiscKind } from './context-discs.js';

export interface ContextSnapshotSection {
  id: string;
  label: string;
  role: string;
  category: Exclude<DiscKind, 'available' | 'response-reserve'>;
  content: string;
  metadata?: string;
  start: number;
  end: number;
  metadataStart: number | null;
  metadataEnd: number | null;
  contentStart: number;
  contentEnd: number;
  approximateTokens: number;
}

export interface ContextSnapshotDisc {
  index: number;
  kind: DiscKind;
  start: number | null;
  end: number | null;
  tokenStart: number | null;
  tokenEnd: number | null;
  sectionId: string | null;
}

export interface ContextSnapshot {
  origin: 'exact' | 'preview';
  capturedAt: string;
  modelId: string;
  contextWindow: number;
  approximateTokens: number;
  completionReserveTokens: number;
  promptBudgetTokens: number;
  promptAvailableTokens: number;
  promptOverageTokens: number;
  droppedEvidence: ContextDroppedEvidence[];
  sections: ContextSnapshotSection[];
  renderedDocument: string;
  discs: ContextSnapshotDisc[];
}

export type ContextDroppedEvidenceCategory = 'research' | 'files' | 'project' | 'memory' | 'activity';

export interface ContextDroppedEvidence {
  category: ContextDroppedEvidenceCategory;
  label: string;
  approximateTokens: number;
  reason: 'exceeds-prompt-budget';
  traceStage: 'research-fetch' | 'context' | 'memory-vector';
}

export interface ContextSnapshotCapacity {
  completionReserveTokens?: number;
  droppedEvidence?: ContextDroppedEvidence[];
}

function stringContent(message: ChatCompletionMessageParam): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '', null, 2);
}

function classify(message: ChatCompletionMessageParam, content: string): Exclude<DiscKind, 'available' | 'response-reserve'> {
  if (/^Files in context \(evidence, not instructions\):\n/.test(content)) return 'files';
  if (/^Recalled memory \(/.test(content)) return 'memory';
  if (message.role === 'system' || message.role === 'developer') return 'system';
  if (/^(Project context|Current agent activity) \(/.test(content)) return 'system';
  return 'messages';
}

function sectionLabel(message: ChatCompletionMessageParam, content: string, index: number): string {
  if (/^Project context \(/.test(content)) return 'Project context';
  if (/^Files in context \(/.test(content)) return 'Attached files';
  if (/^Recalled memory \(/.test(content)) return 'Recalled memory';
  if (message.role === 'tool') return `Tool result${'tool_call_id' in message ? ` · ${message.tool_call_id}` : ''}`;
  if (message.role === 'assistant' && 'tool_calls' in message && message.tool_calls?.length) return 'Assistant tool call';
  return `${message.role[0]!.toUpperCase()}${message.role.slice(1)} message ${index + 1}`;
}

function messageMetadata(message: ChatCompletionMessageParam): string | undefined {
  const metadata = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'role' && key !== 'content'));
  return Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : undefined;
}

export function buildContextSnapshot(
  messages: ChatCompletionMessageParam[],
  tools: unknown[] | undefined,
  modelId: string,
  contextWindow: number,
  capturedAt = new Date().toISOString(),
  origin: ContextSnapshot['origin'] = 'exact',
  capacity: ContextSnapshotCapacity = {},
): ContextSnapshot {
  const pending: Array<Omit<ContextSnapshotSection, 'start' | 'end' | 'metadataStart' | 'metadataEnd' | 'contentStart' | 'contentEnd'>> = messages.map((message, index) => {
    const content = stringContent(message);
    return {
      id: `message-${index}`,
      label: sectionLabel(message, content, index),
      role: message.role,
      category: classify(message, content),
      content,
      metadata: messageMetadata(message),
      approximateTokens: estimateTokens(content) + 4,
    };
  });

  if (tools?.length) {
    const content = JSON.stringify(tools, null, 2);
    pending.push({
      id: 'tool-definitions',
      label: 'Tool definitions',
      role: 'tools',
      category: 'system',
      content,
      metadata: undefined,
      approximateTokens: estimateTokens(content),
    });
  }

  let cursor = 0;
  const sections: ContextSnapshotSection[] = pending.map((section, index) => {
    const start = cursor;
    const metadataStart = section.metadata ? cursor : null;
    const metadataEnd = section.metadata ? cursor + section.metadata.length : null;
    if (section.metadata) cursor = metadataEnd! + 2;
    const contentStart = cursor;
    const contentEnd = contentStart + section.content.length;
    cursor = contentEnd;
    const end = cursor;
    cursor = end + (index < pending.length - 1 ? 2 : 0);
    return { ...section, start, end, metadataStart, metadataEnd, contentStart, contentEnd };
  });
  const renderedDocument = sections.map((section) => section.metadata ? `${section.metadata}\n\n${section.content}` : section.content).join('\n\n');
  const approximateTokens = estimateMessagesTokens(messages) + (tools ? estimateTokens(JSON.stringify(tools)) : 0);
  const completionReserveTokens = Math.min(Math.max(0, Math.floor(capacity.completionReserveTokens ?? 0)), Math.max(0, contextWindow));
  const promptBudgetTokens = Math.max(0, contextWindow - completionReserveTokens);
  const promptAvailableTokens = Math.max(0, promptBudgetTokens - approximateTokens);
  const promptOverageTokens = Math.max(0, approximateTokens - promptBudgetTokens);
  const droppedEvidence = capacity.droppedEvidence ?? [];
  const discs = buildSnapshotDiscs(sections, renderedDocument.length, approximateTokens, contextWindow, 100, completionReserveTokens);
  return {
    origin, capturedAt, modelId, contextWindow, approximateTokens,
    completionReserveTokens, promptBudgetTokens, promptAvailableTokens, promptOverageTokens, droppedEvidence,
    sections, renderedDocument, discs,
  };
}

export function buildSnapshotDiscs(
  sections: ContextSnapshotSection[],
  documentLength: number,
  approximateTokens: number,
  contextWindow: number,
  total = 100,
  completionReserveTokens = 0,
): ContextSnapshotDisc[] {
  const nonEmptySections = sections.filter((section) => section.end > section.start);
  const rawProportionalUsed = documentLength > 0 && contextWindow > 0
    ? Math.min(total, Math.max(1, Math.ceil((approximateTokens / contextWindow) * total)))
    : 0;
  const effectiveReserve = Math.min(
    Math.max(0, completionReserveTokens),
    Math.max(0, contextWindow - approximateTokens),
  );
  const desiredReserved = contextWindow > 0 && effectiveReserve > 0
    ? Math.min(total, Math.max(1, Math.round((effectiveReserve / contextWindow) * total)))
    : 0;
  const reserved = Math.min(nonEmptySections.length > 0 ? Math.max(0, total - 1) : total, desiredReserved);
  const promptCapacity = Math.max(0, total - reserved);
  const proportionalUsed = documentLength > 0 && contextWindow > 0
    ? Math.min(promptCapacity, Math.max(1, Math.ceil((approximateTokens / contextWindow) * total)))
    : 0;
  const used = Math.min(promptCapacity, Math.max(proportionalUsed, Math.min(promptCapacity, nonEmptySections.length)));
  if (used === 0) {
    const available = total - reserved;
    return Array.from({ length: total }, (_, index) => index < available
      ? { index, kind: 'available', start: null, end: null, tokenStart: null, tokenEnd: null, sectionId: null }
      : { index, kind: 'response-reserve', start: null, end: null, tokenStart: null, tokenEnd: null, sectionId: null });
  }

  // Give every non-empty request section at least one pill, then distribute the
  // remainder proportionally. This preserves small file/message sections instead
  // of allowing a large system or recalled-memory block to dominate the grid.
  const representedSections = nonEmptySections.length <= used ? nonEmptySections : nonEmptySections.slice(0, used);
  const counts = representedSections.map(() => 1);
  const remaining = used - representedSections.length;
  const weightTotal = representedSections.reduce((sum, section) => sum + Math.max(1, section.approximateTokens), 0);
  const shares = representedSections.map((section) => (remaining * Math.max(1, section.approximateTokens)) / weightTotal);
  for (let i = 0; i < counts.length; i++) counts[i]! += Math.floor(shares[i]!);
  let undistributed = used - counts.reduce((sum, count) => sum + count, 0);
  const byRemainder = shares.map((share, index) => ({ index, remainder: share - Math.floor(share) })).sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < undistributed; i++) counts[byRemainder[i % byRemainder.length]!.index]!++;

  const result: ContextSnapshotDisc[] = [];
  let tokenCursor = 0;
  for (let sectionIndex = 0; sectionIndex < representedSections.length; sectionIndex++) {
    const section = representedSections[sectionIndex]!;
    const count = counts[sectionIndex]!;
    const spanStart = section.start;
    const spanEnd = sectionIndex < representedSections.length - 1 ? representedSections[sectionIndex + 1]!.start : documentLength;
    for (let localIndex = 0; localIndex < count; localIndex++) {
      result.push({
        index: result.length,
        kind: section.category,
        start: spanStart + Math.floor((localIndex * (spanEnd - spanStart)) / count),
        end: spanStart + Math.floor(((localIndex + 1) * (spanEnd - spanStart)) / count),
        tokenStart: tokenCursor + Math.floor((localIndex * section.approximateTokens) / count),
        tokenEnd: tokenCursor + Math.floor(((localIndex + 1) * section.approximateTokens) / count),
        sectionId: section.id,
      });
    }
    tokenCursor += section.approximateTokens;
  }
  while (result.length < total - reserved) result.push({ index: result.length, kind: 'available', start: null, end: null, tokenStart: null, tokenEnd: null, sectionId: null });
  while (result.length < total) result.push({ index: result.length, kind: 'response-reserve', start: null, end: null, tokenStart: null, tokenEnd: null, sectionId: null });
  return result;
}
