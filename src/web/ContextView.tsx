import React, { useEffect, useRef, useState } from 'react';
import type { DiscKind } from '../context/context-discs.js';
import type { ContextFileSummary, ContextSnapshot, ContextSnapshotDisc, ContextSnapshotSection } from './types.js';

export interface ContextViewProps {
  breakdown: { system: number; files: number; messages: number };
  window: number | null;
  files: ContextFileSummary[];
  onAdd: (path: string) => void | Promise<void>;
  onRemove: (path: string) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  onSearch: (query: string) => Promise<string[]>;
  onLoadSnapshot: () => Promise<ContextSnapshot | null>;
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
function SectionContent({ section, active }: { section: ContextSnapshotSection; active: ContextSnapshotDisc | null }) {
  if (!active || active.start == null || active.end == null || active.end <= section.contentStart || active.start >= section.contentEnd) {
    return <>{section.content}</>;
  }
  const start = Math.max(0, active.start - section.contentStart);
  const end = Math.min(section.content.length, active.end - section.contentStart);
  return <>{section.content.slice(0, start)}<mark>{section.content.slice(start, end)}</mark>{section.content.slice(end)}</>;
}

function MetadataContent({ section, active }: { section: ContextSnapshotSection; active: ContextSnapshotDisc | null }) {
  const metadata = section.metadata ?? '';
  if (!active || active.start == null || active.end == null || section.metadataStart == null || section.metadataEnd == null || active.end <= section.metadataStart || active.start >= section.metadataEnd) return <>{metadata}</>;
  const start = Math.max(0, active.start - section.metadataStart);
  const end = Math.min(metadata.length, active.end - section.metadataStart);
  return <>{metadata.slice(0, start)}<mark>{metadata.slice(start, end)}</mark>{metadata.slice(end)}</>;
}

export function ContextView({ breakdown, window, files, onAdd, onRemove, onClear, onSearch, onLoadSnapshot, onClose }: ContextViewProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [mode, setMode] = useState<'explorer' | 'files'>('explorer');
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [activeDisc, setActiveDisc] = useState<ContextSnapshotDisc | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const pendingNavigation = useRef<ContextSnapshotDisc | null>(null);

  useEffect(() => {
    let cancelled = false;
    void onLoadSnapshot().then((value) => {
      if (!cancelled) {
        setSnapshot(value);
        setSnapshotLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [onLoadSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      void onSearch(query).then((r) => { if (!cancelled) setResults(r); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [query, onSearch]);

  const used = breakdown.system + breakdown.files + breakdown.messages;
  const available = window == null ? 0 : Math.max(0, window - used);
  const amounts: Record<DiscKind, number> = {
    system: breakdown.system,
    files: breakdown.files,
    messages: breakdown.messages,
    available,
  };
  const navigatorAmounts: Record<DiscKind, number> = snapshot ? {
    system: snapshot.sections.filter((section) => section.category === 'system').reduce((sum, section) => sum + section.approximateTokens, 0),
    files: snapshot.sections.filter((section) => section.category === 'files').reduce((sum, section) => sum + section.approximateTokens, 0),
    messages: snapshot.sections.filter((section) => section.category === 'messages').reduce((sum, section) => sum + section.approximateTokens, 0),
    available: Math.max(0, snapshot.contextWindow - snapshot.approximateTokens),
  } : amounts;

  const attached = new Set(files.map((f) => f.path));

  const navigateToDisc = (disc: ContextSnapshotDisc) => {
    if (disc.start == null || !disc.sectionId) return;
    setActiveDisc(disc);
    if (mode !== 'explorer') {
      pendingNavigation.current = disc;
      setMode('explorer');
      return;
    }
    sectionRefs.current.get(disc.sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (mode !== 'explorer' || !pendingNavigation.current) return;
    const disc = pendingNavigation.current;
    pendingNavigation.current = null;
    const frame = requestAnimationFrame(() => {
      if (disc.sectionId) sectionRefs.current.get(disc.sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  return (
    <div className="contextView">
      <header className="contextViewHeader">
        <div>
          <strong>Context {fmt(used)} / {window == null ? '?' : fmt(window)} tokens</strong>
          <nav className="contextTabs" aria-label="Context view">
            <button className={mode === 'explorer' ? 'active' : ''} onClick={() => setMode('explorer')}>Explorer</button>
            <button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')}>Files</button>
          </nav>
        </div>
        <button className="chip" onClick={onClose}>Return</button>
      </header>

      <div className="contextViewBody">
        {snapshotLoaded && snapshot && (
          <div className="contextNavigator">
            <div className="contextSnapshotMeta">
              <strong>{snapshot.origin === 'exact' ? 'Exact request' : 'Preview'}</strong>
              <span>{snapshot.modelId}</span>
              <span>{fmt(snapshot.approximateTokens)} approximate tokens</span>
              <time dateTime={snapshot.capturedAt}>{new Date(snapshot.capturedAt).toLocaleString()}</time>
            </div>
            <div className="contextDiscGrid interactive" aria-label="Navigate model context">
              {snapshot.discs.map((disc) => (
                <button
                  key={disc.index}
                  className={`disc ${disc.kind}${activeDisc?.index === disc.index ? ' active' : ''}`}
                  disabled={disc.start == null}
                  title={disc.start == null ? 'Unused context capacity' : `${disc.kind} · tokens ~${disc.tokenStart}–${disc.tokenEnd} · ${snapshot.sections.find((s) => s.id === disc.sectionId)?.label ?? ''}`}
                  aria-label={disc.start == null ? `Context position ${disc.index + 1}, unused` : `Context position ${disc.index + 1}, ${disc.kind}, approximate tokens ${disc.tokenStart} to ${disc.tokenEnd}`}
                  onClick={() => navigateToDisc(disc)}
                />
              ))}
            </div>
            <div className="contextLegend" aria-label="Context matrix legend">
              {LEGEND.map(({ kind, label }) => (
                <span key={kind} className="legendItem">
                  <span className={`disc ${kind}`} /> {label} {fmt(navigatorAmounts[kind])}
                </span>
              ))}
            </div>
            {activeDisc?.start != null && <p className="contextActiveRange">Selected: {activeDisc.kind} · approximate tokens {activeDisc.tokenStart}–{activeDisc.tokenEnd}</p>}
          </div>
        )}
        {mode === 'explorer' ? (
          <div className="contextExplorer">
            {!snapshotLoaded ? <p className="muted">Loading last model request…</p> : !snapshot ? (
              <div className="contextEmpty"><h3>Context unavailable</h3><p>The current context preview could not be assembled.</p></div>
            ) : <>
              <div className="contextDocument">
                {snapshot.sections.map((section) => (
                  <article key={section.id} ref={(node) => { if (node) sectionRefs.current.set(section.id, node); else sectionRefs.current.delete(section.id); }}>
                    <header><strong>{section.label}</strong><span>{section.role} · ~{fmt(section.approximateTokens)} tokens</span></header>
                    {section.metadata && <details open={!!activeDisc && activeDisc.start != null && section.metadataStart != null && activeDisc.end! > section.metadataStart && activeDisc.start < section.metadataEnd!}><summary>Request metadata</summary><pre><MetadataContent section={section} active={activeDisc} /></pre></details>}
                    <pre><SectionContent section={section} active={activeDisc} /></pre>
                  </article>
                ))}
              </div>
            </>}
          </div>
        ) : <>
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
        </>}
      </div>

      <footer className="contextViewFooter">
        <span className="evalRunReturnHint">Press <kbd>esc</kbd> to return to the chat.</span>
      </footer>
    </div>
  );
}
