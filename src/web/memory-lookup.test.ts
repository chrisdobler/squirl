import { describe, expect, it } from 'vitest';
import { parseMemoryLookup } from './memory-lookup.js';

describe('memory lookup disclosure data', () => {
  it('parses the retrieval summary and dated snippets', () => {
    expect(parseMemoryLookup('recalled 2 memories\n  [Jun 15] find interesting things about our talks\n  [Jun 15] interesting')).toEqual({
      count: 2,
      items: [
        { date: 'Jun 15', snippet: 'find interesting things about our talks' },
        { date: 'Jun 15', snippet: 'interesting' },
      ],
    });
  });

  it('leaves unrelated tool output alone', () => {
    expect(parseMemoryLookup('command completed')).toBeNull();
  });
});
