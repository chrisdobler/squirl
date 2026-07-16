import React, { useEffect, useState } from 'react';
import type { RuntimeStatus } from './types.js';

const LIVE_LIMIT = 120;
const LIVE_SAMPLE_INTERVAL_MS = 250;
const CHART_WIDTH = 216;
const CHART_HEIGHT = 104;
const PLOT = { left: 28, right: 7, top: 8, bottom: 18 };

export interface LivePoint {
  tokensPerSecond: number;
  observedAt: string;
}

export interface LiveTrace {
  generationId: string | null;
  points: LivePoint[];
}

export function appendLiveThroughput(trace: LiveTrace, sample: RuntimeStatus['outputThroughput']): LiveTrace {
  if (!sample) return trace.generationId === null && trace.points.length === 0 ? trace : { generationId: null, points: [] };
  const point = { tokensPerSecond: sample.runningTokensPerSecond, observedAt: sample.observedAt };
  if (trace.generationId !== sample.generationId) {
    return { generationId: sample.generationId, points: sample.runningTokensPerSecond > 0 ? [point] : [] };
  }
  if (!Number.isFinite(sample.runningTokensPerSecond) || sample.runningTokensPerSecond <= 0) return trace;
  const previous = trace.points[trace.points.length - 1];
  if (previous && (sample.observedAt === previous.observedAt || Date.parse(sample.observedAt) - Date.parse(previous.observedAt) < LIVE_SAMPLE_INTERVAL_MS)) return trace;
  return { generationId: trace.generationId, points: [...trace.points, point].slice(-LIVE_LIMIT) };
}

function formatRate(value: number): string {
  return `${Math.round(value)} t/s`;
}

function plottedPoints(points: LivePoint[], maximum: number): Array<{ x: number; y: number }> {
  const width = CHART_WIDTH - PLOT.left - PLOT.right;
  const height = CHART_HEIGHT - PLOT.top - PLOT.bottom;
  return points.map((point, index) => ({
    x: PLOT.left + (points.length <= 1 ? width : (index / (points.length - 1)) * width),
    y: PLOT.top + height - (point.tokensPerSecond / Math.max(1, maximum)) * height,
  }));
}

function linePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

export function LiveThroughputChart({ points }: { points: LivePoint[] }) {
  if (!points.length) return <div className="throughputTakeoverWaiting" role="status">Waiting for output…</div>;
  const maximum = Math.max(...points.map((point) => point.tokensPerSecond));
  const plotted = plottedPoints(points, maximum);
  const latest = points[points.length - 1]!.tokensPerSecond;
  const bottom = CHART_HEIGHT - PLOT.bottom;
  return <>
    <svg className="throughputTakeoverChart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={`Current response running average, latest ${formatRate(latest)}`}>
      <title>Live output speed</title>
      <desc>Running-average token output speed for the response currently streaming.</desc>
      <g className="throughputAxis" aria-hidden="true">
        <line x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={bottom}/>
        <line x1={PLOT.left} y1={bottom} x2={CHART_WIDTH - PLOT.right} y2={bottom}/>
        <line className="grid" x1={PLOT.left} y1={PLOT.top} x2={CHART_WIDTH - PLOT.right} y2={PLOT.top}/>
        <text x={PLOT.left - 4} y={PLOT.top + 3} textAnchor="end">{Math.round(maximum)}</text>
        <text x={PLOT.left - 4} y={bottom + 3} textAnchor="end">0</text>
        <text x={PLOT.left} y={CHART_HEIGHT - 3}>start</text>
        <text x={CHART_WIDTH - PLOT.right} y={CHART_HEIGHT - 3} textAnchor="end">now</text>
      </g>
      {plotted.length > 1 && <path className="throughputLine" d={linePath(plotted)}/>}
      {plotted.map((point, index) => <circle className="throughputPoint" key={index} cx={point.x} cy={point.y} r={index === plotted.length - 1 ? 3 : 2}/>)}
    </svg>
    <footer><span>running average</span><strong>{formatRate(latest)}</strong></footer>
  </>;
}

export function ThroughputPanel({ status }: { status: RuntimeStatus }) {
  const [live, setLive] = useState<LiveTrace>({ generationId: null, points: [] });
  useEffect(() => setLive((current) => appendLiveThroughput(current, status.outputThroughput)), [status.outputThroughput]);
  return <section className="throughputTakeover" aria-live="polite">
    <header><span>output speed</span><strong>streaming</strong></header>
    <LiveThroughputChart points={live.points}/>
  </section>;
}
