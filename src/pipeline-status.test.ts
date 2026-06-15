import { describe, expect, it } from 'vitest';
import { formatPipelineStatus } from './pipeline-status.js';

describe('formatPipelineStatus', () => {
  it('formats empty status as empty text', () => {
    expect(formatPipelineStatus(null)).toBe('');
  });

  it('formats sequential query stage progress', () => {
    expect(formatPipelineStatus({ stage: 'context' })).toBe('query [#-----] 1/6 ctx');
    expect(formatPipelineStatus({ stage: 'vectordb' })).toBe('query [####--] 4/6 VectorDB');
    expect(formatPipelineStatus({ stage: 'model-stream' })).toBe('query [######] 6/6 stream');
  });

  it('formats tool stage as final progress with detail', () => {
    expect(formatPipelineStatus({ stage: 'tool', detail: 'run_command' })).toBe('query [######] 6/6 tool run_command');
  });
});
