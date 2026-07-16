import { describe, expect, it } from 'vitest';
import { presentedConversation } from './conversation-presentation.js';
import type { Message } from './types.js';

describe('presentedConversation', () => {
  const planning: Message = {
    id: 'planning', role: 'assistant', content: 'I will inspect the files first.',
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }],
  };

  it('shows pre-tool planning while it is the latest model output', () => {
    expect(presentedConversation([planning])).toEqual([planning]);
  });

  it('replaces planning with the follow-up answer without removing tool activity', () => {
    const tool: Message = { id: 'tool', role: 'tool', toolCallId: 'call-1', toolName: 'read_file', content: 'result' };
    const final: Message = { id: 'final', role: 'assistant', content: 'Here is the answer.' };
    expect(presentedConversation([planning, tool, final])).toEqual([tool, final]);
  });
});
