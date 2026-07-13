import { describe, expect, it } from 'vitest';
import { chatActivityLabel } from './chat-activity.js';

describe('chatActivityLabel', () => {
  it('shows feedback before the first pipeline event', () => {
    expect(chatActivityLabel(null)).toBe('Preparing context…');
  });

  it('groups retrieval stages under a stable label', () => {
    expect(chatActivityLabel({ stage: 'memory-query' })).toBe('Searching memory…');
    expect(chatActivityLabel({ stage: 'memory-embed' })).toBe('Searching memory…');
    expect(chatActivityLabel({ stage: 'vectordb' })).toBe('Searching memory…');
  });

  it('distinguishes model wait from generation', () => {
    expect(chatActivityLabel({ stage: 'model-connect' })).toBe('Waiting for model…');
    expect(chatActivityLabel({ stage: 'model-stream' })).toBe('Generating response…');
  });
});
