import type { DiscKind } from './context-discs.js';
import type { ContextSnapshot } from './context-snapshot.js';

export type ContextExplorerRow =
  | {
    kind: 'section';
    key: string;
    sectionId: string;
    category: Exclude<DiscKind, 'available'>;
    label: string;
    role: string;
    approximateTokens: number;
  }
  | {
    kind: 'document';
    key: string;
    text: string;
    start: number;
  };

/** Add display-only section headings without changing snapshot document offsets. */
export function buildContextExplorerRows(snapshot: ContextSnapshot): ContextExplorerRow[] {
  const sectionsByStart = new Map<number, ContextSnapshot['sections']>();
  for (const section of snapshot.sections) {
    const sections = sectionsByStart.get(section.start) ?? [];
    sections.push(section);
    sectionsByStart.set(section.start, sections);
  }

  const lines = snapshot.renderedDocument.split('\n');
  const rows: ContextExplorerRow[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    for (const section of sectionsByStart.get(offset) ?? []) {
      rows.push({
        kind: 'section',
        key: `section-${section.id}`,
        sectionId: section.id,
        category: section.category,
        label: section.label,
        role: section.role,
        approximateTokens: section.approximateTokens,
      });
    }
    const text = lines[index]!;
    rows.push({ kind: 'document', key: `document-${index}`, text, start: offset });
    offset += text.length + (index < lines.length - 1 ? 1 : 0);
  }
  return rows;
}

export function findContextExplorerSectionRow(rows: ContextExplorerRow[], sectionId: string): number | null {
  const index = rows.findIndex((row) => row.kind === 'section' && row.sectionId === sectionId);
  return index >= 0 ? index : null;
}
