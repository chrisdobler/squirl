import type { QueryPipelineStatus } from '../pipeline-status.js';

export function chatActivityLabel(status: QueryPipelineStatus | null): string {
  if (!status) return 'Preparing context…';
  switch (status.stage) {
    case 'context': return 'Preparing context…';
    case 'memory-query':
    case 'memory-embed':
    case 'vectordb': return 'Searching memory…';
    case 'model-connect': return 'Waiting for model…';
    case 'model-stream': return 'Generating response…';
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
