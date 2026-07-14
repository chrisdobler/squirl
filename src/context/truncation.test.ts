import { describe, expect, it } from 'vitest';
import { truncateToFit } from './truncation.js';

describe('truncateToFit context roles', () => {
  it('does not promote evidence messages to system priority', () => {
    const result = truncateToFit([
      { role: 'system', content: 'behavior' },
    ], [
      { role: 'user', content: 'project evidence' },
    ], [{ role: 'user', content: 'current request' }], [
      { role: 'user', content: 'possibly stale memory' },
    ], 10_000);

    expect(result.messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user']);
    expect(result.messages[1]?.content).toBe('project evidence');
  });

  it('keeps the current request when base context already exceeds the prompt budget', () => {
    const result = truncateToFit(
      [{ role: 'system', content: 'x'.repeat(20_000) }],
      [],
      [
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'older answer' },
        { role: 'user', content: 'current request must survive' },
      ],
      [{ role: 'user', content: 'optional recalled memory' }],
      8_192,
    );

    expect(result.messages.at(-1)?.content).toBe('current request must survive');
    expect(result.messages.some((message) => message.content === 'optional recalled memory')).toBe(false);
    expect(result.droppedMessageCount).toBe(2);
    expect(result.droppedEvidenceCount).toBe(1);
  });

  it('keeps recent conversation before optional evidence', () => {
    const result = truncateToFit(
      [{ role: 'system', content: 'behavior' }],
      [],
      [
        { role: 'user', content: `recent question ${'q'.repeat(120)}` },
        { role: 'assistant', content: `recent answer ${'a'.repeat(120)}` },
        { role: 'user', content: 'current request' },
      ],
      [
        { role: 'user', content: `attached file ${'f'.repeat(120)}` },
        { role: 'user', content: `memory ${'m'.repeat(120)}` },
      ],
      210,
      100,
    );

    expect(result.messages.map((message) => message.content)).toEqual([
      'behavior',
      `recent question ${'q'.repeat(120)}`,
      `recent answer ${'a'.repeat(120)}`,
      'current request',
    ]);
    expect(result.droppedEvidenceCount).toBe(2);
  });

  it('drops an oversized prior turn as a unit and does not reach past the gap', () => {
    const result = truncateToFit(
      [{ role: 'system', content: 'behavior' }],
      [],
      [
        { role: 'user', content: 'old compact question' },
        { role: 'assistant', content: 'old compact answer' },
        { role: 'user', content: `large recent question ${'q'.repeat(400)}` },
        { role: 'assistant', content: `large recent answer ${'a'.repeat(400)}` },
        { role: 'user', content: 'current request' },
      ],
      [],
      220,
      100,
    );

    expect(result.messages.map((message) => message.content)).not.toContain('old compact question');
    expect(result.messages.at(-1)?.content).toBe('current request');
    expect(result.droppedMessageCount).toBe(4);
  });

  it('keeps matched tool calls and results while removing orphaned tool rows', () => {
    const result = truncateToFit(
      [{ role: 'system', content: 'behavior' }],
      [],
      [
        { role: 'user', content: 'inspect' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'matched' },
        { role: 'tool', tool_call_id: 'orphan', content: 'orphaned' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'current request' },
      ],
      [],
      10_000,
    );

    expect(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call-1')).toBe(true);
    expect(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'orphan')).toBe(false);
  });

  it('keeps explicit project evidence ahead of prior turns and supplemental memory', () => {
    const project = { role: 'user' as const, content: `project ${'p'.repeat(100)}` };
    const memory = { role: 'user' as const, content: `memory ${'m'.repeat(100)}` };
    const result = truncateToFit(
      [{ role: 'system', content: 'behavior' }],
      [project],
      [
        { role: 'user', content: `prior question ${'q'.repeat(120)}` },
        { role: 'assistant', content: `prior answer ${'a'.repeat(120)}` },
        { role: 'user', content: 'current request' },
      ],
      [memory],
      190,
      100,
    );

    expect(result.messages).toContainEqual(project);
    expect(result.messages).not.toContainEqual(memory);
    expect(result.messages.some((message) => message.content === 'current request')).toBe(true);
    expect(result.messages.some((message) => typeof message.content === 'string' && message.content.startsWith('prior question'))).toBe(false);
  });
});
