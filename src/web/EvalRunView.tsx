import React, { useEffect, useRef } from 'react';
import type { JudgeSummary } from './types.js';

export interface EvalRunViewProps {
  title: string;
  lines: string[];
  done: boolean;
  error?: string;
  summary?: JudgeSummary;
  onClose: () => void;
}

function summaryLine(s: JudgeSummary): string {
  const total = s.wins + s.losses + s.ties;
  const pct = total ? Math.round((s.wins / total) * 100) : 0;
  return `memory ${s.wins}W / ${s.losses}L / ${s.ties}T (win-rate ${pct}%) · mean correctness ${s.meanScoreWithMemory.toFixed(2)} with vs ${s.meanScoreWithoutMemory.toFixed(2)} without`;
}

/** Full takeover of the chat pane that streams an eval run's live progress log. */
export function EvalRunView({ title, lines, done, error, summary, onClose }: EvalRunViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length, done]);

  return (
    <div className="evalRunView">
      <header className="evalRunHeader">
        <strong>{title}</strong>
        {!done && !error && <span className="evalRunSpinner" aria-hidden="true">●</span>}
      </header>

      <div className="evalRunLog">
        {lines.map((line, i) => <div key={i} className="evalRunLine">{line}</div>)}
        {summary && <div className="evalRunLine evalRunSummary">{summaryLine(summary)}</div>}
        {error && <div className="evalRunLine evalRunErr">error: {error}</div>}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      <footer className="evalRunFooter">
        {done || error ? (
          <span className="evalRunReturnHint">Press <kbd>esc</kbd> to return to the regular chat window.</span>
        ) : (
          <span className="evalRunRunning">running… (<kbd>esc</kbd> to return)</span>
        )}
        <button className="chip" onClick={onClose}>{done || error ? 'Return' : 'Hide'}</button>
      </footer>
    </div>
  );
}
