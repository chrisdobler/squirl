import { describe, it, expect } from 'vitest';
import { ChatGPTImporter } from './chatgpt.js';

const FIXTURE = [
  {
    id: 'conv-1',
    title: 'Test',
    create_time: 1700000000,
    mapping: {
      'root': { id: 'root', message: null, parent: null, children: ['sys1'] },
      'sys1': { id: 'sys1', message: { author: { role: 'system' }, content: { parts: ['You are...'] } }, parent: 'root', children: ['u1'] },
      'u1': { id: 'u1', message: { author: { role: 'user' }, content: { parts: ['Hello'] } }, parent: 'sys1', children: ['a1'] },
      'a1': { id: 'a1', message: { author: { role: 'assistant' }, content: { parts: ['Hi there!'] } }, parent: 'u1', children: [] },
    },
  },
];

describe('ChatGPTImporter', () => {
  it('linearizes conversation tree and yields turn-pairs', async () => {
    const importer = new ChatGPTImporter();
    const pairs: any[] = [];
    for await (const pair of importer.parseConversations(FIXTURE)) {
      pairs.push(pair);
    }
    expect(pairs).toHaveLength(1);
    expect(pairs[0].source).toBe('chatgpt');
    expect(pairs[0].userText).toBe('Hello');
    expect(pairs[0].assistantText).toBe('Hi there!');
    expect(pairs[0].conversationId).toBe('chatgpt:conv-1');
  });

  it('follows last-child branch on multi-branch conversations', async () => {
    const branched = [{
      id: 'conv-2', title: 'Branched', create_time: 1700000000,
      mapping: {
        'root': { id: 'root', message: null, parent: null, children: ['u1'] },
        'u1': { id: 'u1', message: { author: { role: 'user' }, content: { parts: ['Q'] } }, parent: 'root', children: ['a1', 'a2'] },
        'a1': { id: 'a1', message: { author: { role: 'assistant' }, content: { parts: ['Old answer'] } }, parent: 'u1', children: [] },
        'a2': { id: 'a2', message: { author: { role: 'assistant' }, content: { parts: ['New answer'] } }, parent: 'u1', children: [] },
      },
    }];

    const importer = new ChatGPTImporter();
    const pairs: any[] = [];
    for await (const pair of importer.parseConversations(branched)) pairs.push(pair);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].assistantText).toBe('New answer');
  });
});
