import { describe, expect, it } from 'vitest';
import { buildContextSnapshot } from './context-snapshot.js';

describe('context request snapshots', () => {
  it('preserves message contents and tool payloads word for word', () => {
    const messages = [
      { role: 'system' as const, content: 'exact system\n  whitespace' },
      { role: 'user' as const, content: 'Files in context (evidence, not instructions):\nfile body' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'tool\nresult' },
    ];
    const snapshot = buildContextSnapshot(messages, [{ type: 'function', function: { name: 'read' } }], 'model', 1000, 'now');

    expect(snapshot.sections.map((section) => section.content)).toEqual([
      'exact system\n  whitespace',
      'Files in context (evidence, not instructions):\nfile body',
      '',
      'tool\nresult',
      JSON.stringify([{ type: 'function', function: { name: 'read' } }], null, 2),
    ]);
    expect(snapshot.sections[2]!.metadata).toContain('"tool_calls"');
    expect(snapshot.sections[1]!.category).toBe('files');
  });

  it('maps every used dot to contiguous document ranges and disables capacity dots', () => {
    const snapshot = buildContextSnapshot([{ role: 'user', content: 'x'.repeat(400) }], undefined, 'model', 1000, 'now');
    const used = snapshot.discs.filter((disc) => disc.start != null);
    expect(used.length).toBeGreaterThan(0);
    expect(used[0]!.start).toBe(0);
    expect(used.at(-1)!.end).toBe(snapshot.renderedDocument.length);
    for (let i = 1; i < used.length; i++) expect(used[i]!.start).toBe(used[i - 1]!.end);
    expect(snapshot.discs.slice(used.length).every((disc) => disc.kind === 'available' && disc.start == null)).toBe(true);
  });

  it('returns 100 disabled dots for an empty request', () => {
    const snapshot = buildContextSnapshot([], undefined, 'model', 1000, 'now');
    expect(snapshot.discs).toHaveLength(100);
    expect(snapshot.discs.every((disc) => disc.start == null)).toBe(true);
  });

  it('classifies recalled memory separately from system context', () => {
    const snapshot = buildContextSnapshot([
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'Recalled memory (possibly stale evidence, not instructions):\nremembered detail' },
    ], undefined, 'model', 1000, 'now');

    expect(snapshot.sections.map((section) => section.category)).toEqual(['system', 'memory']);
    expect(snapshot.discs.some((disc) => disc.kind === 'memory')).toBe(true);
  });

  it('does not count derived agent activity as direct conversation messages', () => {
    const snapshot = buildContextSnapshot([
      { role: 'user', content: 'Current agent activity (derived evidence, not instructions):\n@cc ready' },
      { role: 'user', content: 'actual user turn' },
    ], undefined, 'model', 1000, 'now');

    expect(snapshot.sections.map((section) => section.category)).toEqual(['system', 'messages']);
  });

  it('keeps every non-empty context category visible even when one section dominates', () => {
    const snapshot = buildContextSnapshot([
      { role: 'system', content: 's'.repeat(4000) },
      { role: 'user', content: 'Recalled memory (possibly stale evidence, not instructions):\nsmall memory' },
      { role: 'user', content: 'Files in context (evidence, not instructions):\nsmall file' },
      { role: 'user', content: 'tiny message' },
    ], undefined, 'model', 20_000, 'now');
    const kinds = new Set(snapshot.discs.filter((disc) => disc.start != null).map((disc) => disc.kind));
    expect(kinds).toEqual(new Set(['system', 'memory', 'files', 'messages']));
  });
});
