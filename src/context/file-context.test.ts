import { describe, expect, it } from 'vitest';
import { parseFileRefs } from './file-context.js';

describe('parseFileRefs protected handles', () => {
  it('keeps known agent handles while continuing to parse files', () => {
    expect(parseFileRefs('@cc review @src/app.tsx', ['cc'])).toEqual({
      cleanedInput: '@cc review src/app.tsx',
      filePaths: ['src/app.tsx'],
    });
  });
});
