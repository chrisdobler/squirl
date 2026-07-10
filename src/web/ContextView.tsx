import React, { useEffect, useState } from 'react';
import { computeContextDiscs, type DiscKind } from '../context/context-discs.js';
import type { ContextFileSummary } from './types.js';

export interface ContextViewProps {
  breakdown: { system: number; files: number; messages: number };
  window: number | null;
  files: ContextFileSummary[];
  onAdd: (path: string) => void | Promise<void>;
  onRemove: (path: string) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  onSearch: (query: string) => Promise<string[]>;
  onClose: () => void;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

const LEGEND: Array<{ kind: DiscKind; label: string }> = [
  { kind: 'system', label: 'system' },
  { kind: 'files', label: 'files' },
  { kind: 'messages', label: 'messages' },
  { kind: 'available', label: 'available' },
];

/** Full takeover of the chat pane: a faithful recreation of the TUI /context disc grid. */
export function ContextView({ breakdown, window, files, onAdd, onRemove, onClear, onSearch, onClose }: ContextViewProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      void onSearch(query).then((r) => { if (!cancelled) setResults(r); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [query, onSearch]);

  const used = breakdown.system + breakdown.files + breakdown.messages;
  const available = window == null ? 0 : Math.max(0, window - used);
  const discs = computeContextDiscs(breakdown, window ?? 0);
  const amounts: Record<DiscKind, number> = {
    system: breakdown.system,
    files: breakdown.files,
    messages: breakdown.messages,
    available,
  };

  const attached = new Set(files.map((f) => f.path));

  return (
    <div className="contextView">
      <header className="contextViewHeader">
        <strong>Context {fmt(used)} / {window == null ? '?' : fmt(window)} tokens</strong>
        <button className="chip" onClick={onClose}>Return</button>
      </header>

      <div className="contextViewBody">
        <div className="contextDiscGrid" role="img" aria-label={`context budget: ${fmt(used)} of ${window == null ? 'unknown' : fmt(window)} tokens`}>
          {discs.map((kind, i) => <span key={i} className={`disc ${kind}`} />)}
        </div>

        <div className="contextLegend">
          {LEGEND.map(({ kind, label }) => (
            <span key={kind} className="legendItem">
              <span className={`disc ${kind}`} /> {label} {window == null && kind === 'available' ? '—' : fmt(amounts[kind])}
            </span>
          ))}
        </div>

        <div className="contextFiles">
          <div className="contextFilesHead">
            <h3>Current context</h3>
            {files.length > 0 && <button className="chip" onClick={() => void onClear()}>Clear</button>}
          </div>
          {files.length === 0 ? (
            <p className="muted">No files in context</p>
          ) : (
            files.map((file) => (
              <button key={file.path} className="rowButton selected" title="Remove from context" onClick={() => void onRemove(file.path)}>
                <span>{file.path}</span>
                <strong>{fmt(file.tokens)}</strong>
              </button>
            ))
          )}
        </div>

        <div className="contextSearch">
          <label>
            Add file
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspace files" autoFocus />
          </label>
          <div className="fileList">
            {results.filter((p) => !attached.has(p)).slice(0, 20).map((path) => (
              <button key={path} className="rowButton" onClick={() => void onAdd(path)}>
                <span>{path}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <footer className="contextViewFooter">
        <span className="evalRunReturnHint">Press <kbd>esc</kbd> to return to the chat.</span>
      </footer>
    </div>
  );
}
