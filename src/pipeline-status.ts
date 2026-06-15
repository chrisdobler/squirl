export type QueryPipelineStage =
  | 'context'
  | 'memory-query'
  | 'memory-embed'
  | 'vectordb'
  | 'model-connect'
  | 'model-stream'
  | 'tool';

export interface QueryPipelineStatus {
  stage: QueryPipelineStage;
  detail?: string;
}

export const QUERY_PIPELINE_STAGES: QueryPipelineStage[] = [
  'context',
  'memory-query',
  'memory-embed',
  'vectordb',
  'model-connect',
  'model-stream',
];

export const QUERY_PIPELINE_LABELS: Record<QueryPipelineStage, string> = {
  context: 'ctx',
  'memory-query': 'mem query',
  'memory-embed': 'embed',
  vectordb: 'VectorDB',
  'model-connect': 'model',
  'model-stream': 'stream',
  tool: 'tool',
};

export function formatPipelineStatus(status: QueryPipelineStatus | null): string {
  if (!status) return '';
  const stageIndex = status.stage === 'tool'
    ? QUERY_PIPELINE_STAGES.length - 1
    : Math.max(0, QUERY_PIPELINE_STAGES.indexOf(status.stage));
  const current = stageIndex + 1;
  const total = QUERY_PIPELINE_STAGES.length;
  const bar = QUERY_PIPELINE_STAGES
    .map((_stage, i) => i <= stageIndex ? '#' : '-')
    .join('');
  const label = QUERY_PIPELINE_LABELS[status.stage];
  const detail = status.detail ? ` ${status.detail}` : '';
  return `query [${bar}] ${current}/${total} ${label}${detail}`;
}
