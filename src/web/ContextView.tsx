import React, { useEffect, useRef, useState } from 'react';
import type { DiscKind } from '../context/context-discs.js';
import type { ContextFileSummary, ContextSnapshot, ContextSnapshotDisc, ContextSnapshotSection } from './types.js';
import type { UiStateV1 } from './ui-state.js';
import { ContextLegend, ContextMatrix } from './ContextMatrix.js';

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
  initialState: UiStateV1['context'];
  onStateChange: (state: UiStateV1['context']) => void;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

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

export function ContextSectionHeader({ section }: { section: ContextSnapshotSection }) {
  const categoryLabel = section.category === 'memory' ? 'recalled memory' : section.category;
  return <header>
    <strong className="contextSectionTitle">
      <span className={`disc ${section.category} contextSectionDisc`} role="img" aria-label={`${categoryLabel} context`} />
      <span>{section.label}</span>
    </strong>
    <span className="contextSectionMeta">{section.role} · ~{fmt(section.approximateTokens)} tokens</span>
  </header>;
}

export function ContextView({ breakdown, window, files, onAdd, onRemove, onClear, onSearch, onLoadSnapshot, onClose, initialState, onStateChange }: ContextViewProps) {
  const [query, setQuery] = useState(initialState.query);
  const [results, setResults] = useState<string[]>([]);
  const [mode, setMode] = useState<'explorer' | 'files'>(initialState.mode);
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
    if (!snapshot || initialState.activeDiscIndex == null) return;
    setActiveDisc(snapshot.discs.find((disc) => disc.index === initialState.activeDiscIndex) ?? null);
  }, [snapshot, initialState.activeDiscIndex]);

  useEffect(() => {
    onStateChange({ mode, query, activeDiscIndex: activeDisc?.index ?? null });
  }, [mode, query, activeDisc?.index, onStateChange]);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      void onSearch(query).then((r) => { if (!cancelled) setResults(r); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [query, onSearch]);

  const breakdownUsed = breakdown.system + breakdown.files + breakdown.messages;
  const breakdownAvailable = window == null ? 0 : Math.max(0, window - breakdownUsed);
  const amounts: Record<DiscKind, number> = {
    system: breakdown.system,
    memory: 0,
    files: breakdown.files,
    messages: breakdown.messages,
    available: breakdownAvailable,
  };
  const navigatorAmounts: Record<DiscKind, number> = snapshot ? {
    system: snapshot.sections.filter((section) => section.category === 'system').reduce((sum, section) => sum + section.approximateTokens, 0),
    memory: snapshot.sections.filter((section) => section.category === 'memory').reduce((sum, section) => sum + section.approximateTokens, 0),
    files: snapshot.sections.filter((section) => section.category === 'files').reduce((sum, section) => sum + section.approximateTokens, 0),
    messages: snapshot.sections.filter((section) => section.category === 'messages').reduce((sum, section) => sum + section.approximateTokens, 0),
    available: 0,
  } : amounts;
  const used = snapshot
    ? navigatorAmounts.system + navigatorAmounts.memory + navigatorAmounts.files + navigatorAmounts.messages
    : breakdownUsed;
  if (snapshot) navigatorAmounts.available = Math.max(0, snapshot.contextWindow - used);
  const contextWindow = snapshot?.contextWindow ?? window;

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
          <strong>Context {fmt(used)} / {contextWindow == null ? '?' : fmt(contextWindow)} tokens</strong>
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
            <ContextMatrix
              label="Navigate model context"
              activeIndex={activeDisc?.index}
              cells={snapshot.discs.map((disc) => ({
                index: disc.index,
                kind: disc.kind,
                disabled: disc.start == null,
                title: disc.start == null ? 'Unused context capacity' : `${disc.kind} · tokens ~${disc.tokenStart}–${disc.tokenEnd} · ${snapshot.sections.find((s) => s.id === disc.sectionId)?.label ?? ''}`,
                ariaLabel: disc.start == null ? `Context position ${disc.index + 1}, unused` : `Context position ${disc.index + 1}, ${disc.kind}, approximate tokens ${disc.tokenStart} to ${disc.tokenEnd}`,
              }))}
              onSelect={(cell) => {
                const disc = snapshot.discs.find((candidate) => candidate.index === cell.index);
                if (disc) navigateToDisc(disc);
              }}
            />
            <ContextLegend amounts={navigatorAmounts} formatAmount={fmt} />
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
                    <ContextSectionHeader section={section} />
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
