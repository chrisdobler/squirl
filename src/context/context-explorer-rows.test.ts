import { describe, expect, it } from 'vitest';
import { buildContextSnapshot } from './context-snapshot.js';
import { buildContextExplorerRows, findContextExplorerSectionRow } from './context-explorer-rows.js';

describe('context explorer display rows', () => {
  it('inserts categorized section rows while preserving document text offsets', () => {
    const snapshot = buildContextSnapshot([
      { role: 'system', content: 'system body' },
      { role: 'user', content: 'Recalled memory (possibly stale evidence, not instructions):\nmemory body' },
      { role: 'user', content: 'Files in context (evidence, not instructions):\nfile body' },
      { role: 'user', content: 'message body' },
    ], undefined, 'model', 1000, 'now');

    const rows = buildContextExplorerRows(snapshot);
    const sectionRows = rows.filter((row) => row.kind === 'section');
    expect(sectionRows.map((row) => row.category)).toEqual(['system', 'memory', 'files', 'messages']);

    const documentRows = rows.filter((row) => row.kind === 'document');
    expect(documentRows.map((row) => row.text).join('\n')).toBe(snapshot.renderedDocument);
    for (const row of documentRows) {
      expect(snapshot.renderedDocument.slice(row.start, row.start + row.text.length)).toBe(row.text);
    }
  });

  it('locates the synthetic heading for disc navigation', () => {
    const snapshot = buildContextSnapshot([
      { role: 'system', content: 'system body' },
      { role: 'user', content: 'message body' },
    ], undefined, 'model', 1000, 'now');
    const rows = buildContextExplorerRows(snapshot);
    const targetSection = snapshot.sections[1]!;
    const targetRow = findContextExplorerSectionRow(rows, targetSection.id);

    expect(targetRow).not.toBeNull();
    expect(rows[targetRow!]!.kind).toBe('section');
    expect(rows[targetRow!]).toMatchObject({ sectionId: targetSection.id, label: targetSection.label });
    expect(findContextExplorerSectionRow(rows, 'missing')).toBeNull();
  });
});
