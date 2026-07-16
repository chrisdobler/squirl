export type SemanticProgressStage =
  | 'action-plan'
  | 'capability'
  | 'turn-intent'
  | 'memory'
  | 'research'
  | 'context';

export interface SemanticProgressUpdate {
  stage: SemanticProgressStage;
  label: string;
  state: 'running' | 'complete';
  /** Human-readable result for the inline chat/TUI status. Structured output remains diagnostic. */
  summary?: string;
  output?: unknown;
}

export interface TurnSemanticProgress extends SemanticProgressUpdate {
  turnId: string;
}

export function formatSemanticProgress(progress: SemanticProgressUpdate): string {
  if (progress.state === 'running') return progress.label;
  if (progress.summary) return `${progress.label}\n\n${progress.summary}`;
  if (progress.output === undefined) return progress.label;
  return `${progress.label}\n\n\`\`\`json\n${JSON.stringify(progress.output, null, 2)}\n\`\`\``;
}
