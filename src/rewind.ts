import type { Message } from './types.js';

export interface RewindRequest {
  targetMessageId: string | null;
  retainedCount: number;
  removedCount: number;
  label: string;
}

export interface RewindCandidate {
  message: Message;
  messageIndex: number;
  retainedCount: number;
  removedCount: number;
  label: string;
}

export function roleLabel(message: Message): string {
  if (message.role === 'tool') return `tool:${message.toolName}`;
  return message.role;
}

export function preview(content: string, maxLength = 72): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}

export function buildRewindCandidates(messages: Message[]): RewindCandidate[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user') return [];
    const nextUserIndex = messages.findIndex((m, i) => i > index && m.role === 'user');
    const retainedCount = nextUserIndex === -1 ? messages.length : nextUserIndex;
    if (retainedCount >= messages.length) return [];
    return [{
      message,
      messageIndex: index,
      retainedCount,
      removedCount: messages.length - retainedCount,
      label: `${index + 1}. user — ${preview(message.content)}`,
    }];
  });
}

export function rewindRequestFromCandidate(candidate: RewindCandidate): RewindRequest {
  return {
    targetMessageId: candidate.message.id,
    retainedCount: candidate.retainedCount,
    removedCount: candidate.removedCount,
    label: candidate.label,
  };
}
