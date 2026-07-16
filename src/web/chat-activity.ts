import type { QueryPipelineStatus } from '../pipeline-status.js';
import type { Message } from '../types.js';

/** Routine turn bookkeeping is redundant with the live acorn and stays out of chat. */
export function withoutRoutineAssignmentCards(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== 'activity'
    || (message.activity.kind !== 'assignment' && !message.id.startsWith('activity-turn-')));
}

export function chatActivityLabel(status: QueryPipelineStatus | null): string {
  if (!status) return 'Preparing context…';
  switch (status.stage) {
    case 'context': return 'Preparing context…';
    case 'capability': return 'Checking model capabilities…';
    case 'turn-intent': return 'Routing request…';
    case 'memory-query':
    case 'memory-embed':
    case 'vectordb': return 'Searching memory…';
    case 'research-consent': return 'Checking research permission…';
    case 'research-search': return 'Searching the web…';
    case 'research-fetch': return 'Reading sources…';
    case 'model-connect': return 'Waiting for model…';
    case 'model-stream': return 'Generating response…';
    case 'confidence': return 'Assessing response…';
    case 'tool': return status.detail ? `Running ${status.detail}…` : 'Using a tool…';
  }
}

export function participantActivityLabel(
  participantId: string,
  participantLabel: string,
  detail: string | undefined,
  squirlPipelineStatus: QueryPipelineStatus | null,
): string {
  if (participantId === 'squirl') return chatActivityLabel(squirlPipelineStatus);
  return detail ? `${participantLabel} is running ${detail}…` : `${participantLabel} is working…`;
}
