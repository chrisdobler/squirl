import React from 'react';

import type { DiscKind } from '../context/context-discs.js';

export const CONTEXT_LEGEND: Array<{ kind: DiscKind; label: string }> = [
  { kind: 'system', label: 'system' },
  { kind: 'memory', label: 'recalled memory' },
  { kind: 'files', label: 'files' },
  { kind: 'messages', label: 'messages' },
  { kind: 'available', label: 'available' },
];

export interface ContextMatrixCell {
  index: number;
  kind: DiscKind;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export function ContextMatrix({ cells, activeIndex, compact = false, label = 'Context matrix', onSelect }: {
  cells: ContextMatrixCell[];
  activeIndex?: number | null;
  compact?: boolean;
  label?: string;
  onSelect?: (cell: ContextMatrixCell) => void;
}) {
  return <div className={`contextDiscGrid${onSelect ? ' interactive' : ''}${compact ? ' compact' : ''}`} aria-label={label}>
    {cells.map((cell) => onSelect && !cell.disabled ? (
      <button
        key={cell.index}
        className={`disc ${cell.kind}${activeIndex === cell.index ? ' active' : ''}`}
        title={cell.title}
        aria-label={cell.ariaLabel ?? cell.title ?? `${cell.kind} context cell ${cell.index + 1}`}
        onClick={() => onSelect(cell)}
      />
    ) : (
      <span
        key={cell.index}
        className={`disc ${cell.kind}${activeIndex === cell.index ? ' active' : ''}`}
        title={cell.title}
        aria-hidden="true"
      />
    ))}
  </div>;
}

export function ContextLegend({ compact = false, amounts, formatAmount = String }: {
  compact?: boolean;
  amounts?: Partial<Record<DiscKind, number>>;
  formatAmount?: (amount: number) => string;
}) {
  return <div className={`contextLegend${compact ? ' compact' : ''}`} aria-label="Context matrix legend">
    {CONTEXT_LEGEND.map((item) => (
      <span className="legendItem" key={item.kind}>
        <span className={`disc ${item.kind}`} /> {item.label}{amounts?.[item.kind] != null ? ` ${formatAmount(amounts[item.kind]!)}` : ''}
      </span>
    ))}
  </div>;
}
