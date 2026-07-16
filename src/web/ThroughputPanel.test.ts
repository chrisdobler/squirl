import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { appendLiveThroughput, LiveThroughputChart } from './ThroughputPanel.js';

describe('live throughput panel', () => {
  it('throttles, bounds, and resets samples by generation', () => {
    let trace = { generationId: null as string | null, points: [] as Array<{ tokensPerSecond: number; observedAt: string }> };
    trace = appendLiveThroughput(trace, { generationId: 'one', runningTokensPerSecond: 10, observedAt: '2026-07-15T12:00:00.000Z' });
    trace = appendLiveThroughput(trace, { generationId: 'one', runningTokensPerSecond: 11, observedAt: '2026-07-15T12:00:00.100Z' });
    expect(trace.points.map((point) => point.tokensPerSecond)).toEqual([10]);
    for (let index = 1; index <= 130; index += 1) {
      trace = appendLiveThroughput(trace, { generationId: 'one', runningTokensPerSecond: index, observedAt: new Date(Date.parse('2026-07-15T12:00:00.000Z') + index * 250).toISOString() });
    }
    expect(trace.points).toHaveLength(120);
    expect(appendLiveThroughput(trace, { generationId: 'two', runningTokensPerSecond: 7, observedAt: '2026-07-15T13:00:00.000Z' })).toEqual({
      generationId: 'two', points: [{ tokensPerSecond: 7, observedAt: '2026-07-15T13:00:00.000Z' }],
    });
  });

  it('renders a labeled live line chart and waiting state', () => {
    const chart = renderToStaticMarkup(React.createElement(LiveThroughputChart, { points: [
      { tokensPerSecond: 12, observedAt: '2026-07-15T12:00:00.000Z' },
      { tokensPerSecond: 18, observedAt: '2026-07-15T12:00:00.250Z' },
    ] }));
    expect(chart).toContain('Live output speed');
    expect(chart).toContain('running average');
    expect(chart).toContain('18 t/s');
    expect(renderToStaticMarkup(React.createElement(LiveThroughputChart, { points: [] }))).toContain('Waiting for output…');
  });
});
