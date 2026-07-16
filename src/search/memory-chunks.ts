import { createHash } from 'node:crypto';
import type { Message } from '../types.js';

export const MEMORY_INDEX_VERSION = 2;
export const MEMORY_CHUNK_MAX_CHARS = 768;
export const MEMORY_CHUNK_OVERLAP_CHARS = 96;
export const MEMORY_CONTEXT_MAX_CHARS = 240;
export const MEMORY_PREVIEW_MAX_CHARS = 240;

export type MemoryChunkState = 'pending' | 'indexing' | 'indexed' | 'failed';

export interface MemoryChunk {
  id: string;
  roomId: string;
  turnId?: string;
  sourceMessageId: string;
  contextMessageId?: string;
  ordinal: number;
  role: 'user' | 'assistant';
  participantId?: string;
  content: string;
  contextText?: string;
  contentHash: string;
  indexVersion: number;
  state: MemoryChunkState;
  attempts: number;
  createdAt: string;
}

export interface MemoryVectorRecord {
  chunk: MemoryChunk;
  embedding: number[];
  preview: string;
}

export interface MemoryVectorHit {
  chunkId: string;
  score: number;
  roomId: string;
  role: 'user' | 'assistant';
  participantId?: string;
  indexVersion: number;
  contentHash: string;
}

export interface MemoryVectorIndex {
  upsert(records: MemoryVectorRecord[]): Promise<void>;
  query(embedding: number[], k: number, roomId: string): Promise<MemoryVectorHit[]>;
  has(ids: string[]): Promise<Set<string>>;
  delete(ids: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface MemorySearchResult {
  id: string;
  score: number;
  chunk: MemoryChunk;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function hardSplit(text: string): string[] {
  const chunks: string[] = [];
  const step = MEMORY_CHUNK_MAX_CHARS - MEMORY_CHUNK_OVERLAP_CHARS;
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + MEMORY_CHUNK_MAX_CHARS));
    if (start + MEMORY_CHUNK_MAX_CHARS >= text.length) break;
  }
  return chunks;
}

/** Pack paragraph/sentence units without ever discarding the tail of a long message. */
export function splitMemoryContent(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const units = normalized
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9#*`])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => part.length > MEMORY_CHUNK_MAX_CHARS ? hardSplit(part) : [part]);
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= MEMORY_CHUNK_MAX_CHARS) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = unit;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function memoryEmbeddingText(chunk: Pick<MemoryChunk, 'content' | 'contextText' | 'participantId' | 'role'>): string {
  const speaker = chunk.participantId ? `@${chunk.participantId}` : chunk.role === 'user' ? '@user' : '@squirl';
  return [chunk.contextText ? `Context: ${chunk.contextText}` : '', `${speaker}: ${chunk.content}`].filter(Boolean).join('\n');
}

export function chunksForMessage(input: {
  roomId: string;
  message: Message;
  turnId?: string;
  timestamp: string;
  contextMessage?: Message;
}): MemoryChunk[] {
  if (input.message.role === 'tool' || input.message.role === 'activity') return [];
  const message = input.message;
  const contextText = input.contextMessage?.role === 'user'
    ? input.contextMessage.content.slice(0, MEMORY_CONTEXT_MAX_CHARS)
    : undefined;
  return splitMemoryContent(message.content).map((content, ordinal) => ({
    id: sha1(`memory-v${MEMORY_INDEX_VERSION}\0${input.roomId}\0${message.id}\0${ordinal}`),
    roomId: input.roomId,
    turnId: input.turnId,
    sourceMessageId: message.id,
    contextMessageId: input.contextMessage?.id,
    ordinal,
    role: message.role,
    participantId: message.participantId,
    content,
    contextText,
    contentHash: sha1(content),
    indexVersion: MEMORY_INDEX_VERSION,
    state: 'pending',
    attempts: 0,
    createdAt: input.timestamp,
  }));
}
