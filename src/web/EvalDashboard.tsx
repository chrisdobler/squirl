import React, { useMemo, useState } from 'react';
import type { HistoryEntry, EvalRunRequest } from './types.js';

// A metric is a 0..1 line on the trend chart. `get` returns null when the entry lacks the metric.
interface MetricLine {
  key: string;
  label: string;
  color: string;
  get: (e: HistoryEntry) => number | null;
}

const winRate = (e: HistoryEntry): number | null =>
  e.judge ? e.judge.wins / Math.max(1, e.judge.wins + e.judge.losses + e.judge.ties) : null;

const METRIC_LINES: MetricLine[] = [
  { key: 'recall5', label: 'recall@5', color: '#22d3ee', get: (e) => e.metrics.recallAtK[5] ?? null },
  { key: 'recall10', label: 'recall@10', color: '#4ade80', get: (e) => e.metrics.recallAtK[10] ?? null },
  { key: 'ndcg10', label: 'nDCG@10', color: '#facc15', get: (e) => e.metrics.ndcgAtK[10] ?? null },
  { key: 'mrr', label: 'MRR', color: '#60a5fa', get: (e) => (typeof e.metrics.mrr === 'number' ? e.metrics.mrr : null) },
  { key: 'winRate', label: 'memory win-rate', color: '#e879f9', get: winRate },
  { key: 'correctness', label: 'answer correctness', color: '#f97316', get: (e) => (e.judge ? e.judge.meanScoreWithMemory / 5 : null) },
];

function seriesKeyOf(e: HistoryEntry): string {
  return `${e.layer}:${e.mode}:${e.embedderName}:${e.chunkHash}`;
}

function seriesLabel(e: HistoryEntry): string {
  return `L${e.layer} · ${e.mode} · ${e.embedderName}`;
}

const W = 540, H = 240, PAD_L = 34, PAD_R = 12, PAD_T = 14, PAD_B = 26;

function LineChart({ entries, hidden }: { entries: HistoryEntry[]; hidden: Set<string> }) {
  const n = entries.length;
  const xFor = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R));
  const yFor = (v: number) => PAD_T + (1 - v) * (H - PAD_T - PAD_B);

  const visibleLines = METRIC_LINES.filter(
    (m) => !hidden.has(m.key) && entries.some((e) => m.get(e) !== null),
  );

  return (
    <svg className="evalChart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="metric trend">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => (
        <g key={g}>
          <line x1={PAD_L} y1={yFor(g)} x2={W - PAD_R} y2={yFor(g)} className="evalGrid" />
          <text x={PAD_L - 6} y={yFor(g) + 3} className="evalAxis" textAnchor="end">{g}</text>
        </g>
      ))}
      {visibleLines.map((m) => {
        const pts = entries
          .map((e, i) => ({ i, v: m.get(e) }))
          .filter((p): p is { i: number; v: number } => p.v !== null);
        const path = pts.map((p) => `${xFor(p.i)},${yFor(p.v)}`).join(' ');
        return (
          <g key={m.key}>
            {pts.length > 1 && <polyline points={path} fill="none" stroke={m.color} strokeWidth={2} />}
            {pts.map((p) => <circle key={p.i} cx={xFor(p.i)} cy={yFor(p.v)} r={2.5} fill={m.color} />)}
          </g>
        );
      })}
      {n > 0 && (
        <>
          <text x={PAD_L} y={H - 8} className="evalAxis" textAnchor="start">{entries[0]!.timestamp.slice(5, 10)}</text>
          <text x={W - PAD_R} y={H - 8} className="evalAxis" textAnchor="end">{entries[n - 1]!.timestamp.slice(5, 10)}</text>
        </>
      )}
    </svg>
  );
}

function fmt(v: number | null): string {
  return v === null ? '—' : v.toFixed(3);
}

export interface EvalDashboardProps {
  history: HistoryEntry[];
  running: boolean;
  progress?: string;
  error?: string;
  monitorEnabled: boolean;
  onRefresh: () => void;
  onRun: (req: EvalRunRequest) => void;
  onToggleMonitor: (enabled: boolean) => void;
}

export function EvalDashboard({ history, running, progress, error, monitorEnabled, onRefresh, onRun, onToggleMonitor }: EvalDashboardProps) {
  // Group into comparable series; default to the series of the most recent run.
  const series = useMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const e of history) {
      const k = seriesKeyOf(e);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    return groups;
  }, [history]);

  const seriesKeys = [...series.keys()];
  const defaultKey = history.length ? seriesKeyOf(history[history.length - 1]!) : '';
  const [selectedKey, setSelectedKey] = useState<string>(defaultKey);
  const activeKey = series.has(selectedKey) ? selectedKey : defaultKey;
  const entries = useMemo(() => {
    const list = (series.get(activeKey) ?? []).slice();
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return list;
  }, [series, activeKey]);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setHidden((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const [layer, setLayer] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<'frozen' | 'live'>('frozen');
  const [label, setLabel] = useState('');

  const presentLines = METRIC_LINES.filter((m) => entries.some((e) => m.get(e) !== null));

  return (
    <div className="panel evalPanel">
      <header>
        <h2>eval</h2>
        <label className="evalMonitor" title="Periodically run an eval automatically so squirl self-monitors its memory quality">
          <input type="checkbox" checked={monitorEnabled} onChange={(e) => onToggleMonitor(e.target.checked)} />
          auto-monitor
        </label>
        <button className="chip" onClick={onRefresh} disabled={running}>refresh</button>
      </header>

      <div className="evalRun">
        <select value={layer} onChange={(e) => setLayer(Number(e.target.value) as 1 | 2 | 3)} disabled={running}>
          <option value={1}>Layer 1 · retrieval</option>
          <option value={2}>Layer 2 · end-to-end</option>
          <option value={3}>Layer 3 · answer quality</option>
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'frozen' | 'live')} disabled={running}>
          <option value="frozen">frozen</option>
          <option value="live">live</option>
        </select>
        <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={running} />
        <button
          className="primary"
          disabled={running}
          onClick={() => onRun({ layer, mode, ...(label.trim() ? { label: label.trim() } : {}) })}
        >
          {running ? 'running…' : 'Run'}
        </button>
      </div>
      {running && <p className="evalStatus">{progress ?? 'starting…'}</p>}
      {error && <p className="evalError">{error}</p>}

      {history.length === 0 ? (
        <p className="evalEmpty">No eval runs yet. Click Run to record the first data point.</p>
      ) : (
        <>
          {seriesKeys.length > 1 && (
            <select className="evalSeries" value={activeKey} onChange={(e) => setSelectedKey(e.target.value)}>
              {seriesKeys.map((k) => (
                <option key={k} value={k}>{seriesLabel(series.get(k)![0]!)} ({series.get(k)!.length})</option>
              ))}
            </select>
          )}

          <LineChart entries={entries} hidden={hidden} />

          <div className="evalLegend">
            {presentLines.map((m) => (
              <button
                key={m.key}
                className={hidden.has(m.key) ? 'off' : ''}
                onClick={() => toggle(m.key)}
              >
                <span className="swatch" style={{ background: m.color }} /> {m.label}
              </button>
            ))}
          </div>

          <table className="evalTable">
            <thead>
              <tr><th>when</th><th>label</th><th>recall@5</th><th>nDCG@10</th><th>MRR</th><th>win-rate</th></tr>
            </thead>
            <tbody>
              {entries.slice().reverse().map((e, idx) => (
                <tr key={e.timestamp + idx}>
                  <td>{e.timestamp.slice(5, 16).replace('T', ' ')}</td>
                  <td>{e.label}</td>
                  <td>{fmt(e.metrics.recallAtK[5] ?? null)}</td>
                  <td>{fmt(e.metrics.ndcgAtK[10] ?? null)}</td>
                  <td>{fmt(typeof e.metrics.mrr === 'number' ? e.metrics.mrr : null)}</td>
                  <td>{fmt(winRate(e))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
