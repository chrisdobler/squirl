import { describe, expect, it } from 'vitest';
import { createTurnPipelineTrace, finishTurnPipelineTrace, safeTraceValue, updateTurnPipelineTrace } from './pipeline-trace.js';

describe('turn pipeline trace', () => {
  it('tracks stage lifecycle and retains a safe bounded payload', () => {
    let trace = createTurnPipelineTrace('turn-1', 'question');
    trace = updateTurnPipelineTrace(trace, { id: 'turn-intent', state: 'running', input: { authorization: 'secret', prompt: 'x'.repeat(5_000) } });
    trace = updateTurnPipelineTrace(trace, { id: 'turn-intent', state: 'succeeded', output: { research: { needed: true } } });
    trace = finishTurnPipelineTrace(trace, 'succeeded');
    const stage = trace.stages.find((item) => item.id === 'turn-intent')!;
    expect(stage.input).toMatchObject({ authorization: '[redacted]' });
    expect(JSON.stringify(stage.input)).toContain('[truncated');
    expect(stage.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.state).toBe('succeeded');
  });

  it('does not expose secret-shaped nested keys', () => {
    expect(safeTraceValue({ nested: { apiKey: 'value', cookie: 'session', promptTokens: 42 } })).toEqual({ nested: { apiKey: '[redacted]', cookie: '[redacted]', promptTokens: 42 } });
  });

  it('closes unfinished stages explicitly when a turn ends', () => {
    const trace = finishTurnPipelineTrace(createTurnPipelineTrace('turn-2', 'question'), 'failed');
    expect(trace.stages.find((stage) => stage.id === 'capability')).toMatchObject({ state: 'skipped' });
  });

  it('describes action planning as request routing while retaining its diagnostic output', () => {
    const trace = updateTurnPipelineTrace(createTurnPipelineTrace('turn-3', 'question'), {
      id: 'action-plan', state: 'succeeded', output: { kind: 'none' },
    });
    expect(trace.stages.find((stage) => stage.id === 'action-plan')).toMatchObject({
      label: 'Request routing', output: { kind: 'none' },
    });
  });
});
