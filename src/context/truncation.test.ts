import { describe, expect, it } from 'vitest';
import { truncateToFit } from './truncation.js';

describe('truncateToFit context roles', () => {
  it('does not promote evidence messages to system priority', () => {
    const result = truncateToFit([
      { role: 'system', content: 'behavior' },
    ], [
      { role: 'user', content: 'project evidence' },
      { role: 'user', content: 'possibly stale memory' },
    ], [{ role: 'user', content: 'current request' }], 10_000);

    expect(result.messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user']);
    expect(result.messages[1]?.content).toBe('project evidence');
  });

  it('keeps the current request when base context already exceeds the prompt budget', () => {
    const result = truncateToFit(
      [{ role: 'system', content: 'x'.repeat(20_000) }],
      [{ role: 'user', content: 'optional recalled memory' }],
      [
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'older answer' },
        { role: 'user', content: 'current request must survive' },
      ],
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
      [
        { role: 'user', content: `attached file ${'f'.repeat(120)}` },
        { role: 'user', content: `memory ${'m'.repeat(120)}` },
      ],
      [
        { role: 'user', content: `recent question ${'q'.repeat(120)}` },
        { role: 'assistant', content: `recent answer ${'a'.repeat(120)}` },
        { role: 'user', content: 'current request' },
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
});
