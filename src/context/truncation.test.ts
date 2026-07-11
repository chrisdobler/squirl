import { describe, expect, it } from 'vitest';
import { truncateToFit } from './truncation.js';

describe('truncateToFit context roles', () => {
  it('does not promote evidence messages to system priority', () => {
    const result = truncateToFit([
      { role: 'system', content: 'behavior' },
      { role: 'user', content: 'project evidence' },
      { role: 'user', content: 'possibly stale memory' },
    ], null, [{ role: 'user', content: 'current request' }], 10_000);

    expect(result.messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user']);
    expect(result.messages[1]?.content).toBe('project evidence');
  });
});
