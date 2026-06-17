import { describe, expect, it, vi } from 'vitest';
import type { StreamOptions } from './api.js';
import type { AssistantMessage, Message } from './types.js';

const mocks = vi.hoisted(() => ({
  streamChatCompletion: vi.fn(),
}));

vi.mock('./api.js', () => ({
  streamChatCompletion: mocks.streamChatCompletion,
}));

describe('Orchestrator streaming callbacks', () => {
  it('does not mutate the assistant message object passed to onNewMessage', async () => {
    mocks.streamChatCompletion.mockImplementation(async (options: StreamOptions) => {
      options.onToken("I'm");
      options.onDone({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    });

    const { Orchestrator } = await import('./orchestrator.js');
    const orchestrator = new Orchestrator('/tmp/squirl-orchestrator-test');
    const callbackMessages: Message[] = [];
    const tokenSnapshots: AssistantMessage[] = [];

    const returned = await orchestrator.chat(
      'hello',
      [],
      { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
      {
        onNewMessage: (message) => { callbackMessages.push(message); },
        onToken: (_token, assistant) => { tokenSnapshots.push(assistant); },
        onDone: () => {},
        onError: () => {},
      },
    );

    const callbackAssistant = callbackMessages.find((message): message is AssistantMessage => message.role === 'assistant');
    const returnedAssistant = returned.find((message): message is AssistantMessage => message.role === 'assistant');

    expect(callbackAssistant?.content).toBe('');
    expect(tokenSnapshots.map((snapshot) => snapshot.content)).toEqual(["I'm"]);
    expect(returnedAssistant?.content).toBe("I'm");
  });
});
