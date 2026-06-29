import { describe, it, expect, vi } from 'vitest';
import type { SelectedModel } from '../../components/ModelPicker.js';

const { streamChatCompletion } = vi.hoisted(() => ({ streamChatCompletion: vi.fn() }));
vi.mock('../../api.js', () => ({ streamChatCompletion }));

const { generateAnswer } = await import('./answer.js');

const model: SelectedModel = { id: 'm', label: 'm', provider: 'local', baseUrl: 'http://x/v1' };

// NOTE: deliberately no beforeEach mock-clear — clearing a vi.hoisted mock in beforeEach makes
// vitest 4 forward zero args to the implementation. Each test sets its own implementation and reads
// mock.lastCall, so cross-test accumulation is harmless.

describe('generateAnswer', () => {
  it('orders messages system → conversation → user and accumulates tokens', async () => {
    streamChatCompletion.mockImplementation(async (opts: any) => {
      opts.onToken('Hello');
      opts.onToken(' world');
      opts.onDone({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    });

    const out = await generateAnswer({
      model,
      systemMessages: ['sys-A', 'sys-B'],
      conversation: [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }],
      userMessage: 'final q',
    });

    expect(out).toBe('Hello world');
    expect(streamChatCompletion.mock.lastCall![0].messages).toEqual([
      { role: 'system', content: 'sys-A' },
      { role: 'system', content: 'sys-B' },
      { role: 'user', content: 'earlier q' },
      { role: 'assistant', content: 'earlier a' },
      { role: 'user', content: 'final q' },
    ]);
  });

  it('omits empty system messages', async () => {
    streamChatCompletion.mockImplementation(async (opts: any) => opts.onDone({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
    await generateAnswer({ model, systemMessages: ['', '  '], conversation: [], userMessage: 'q' });
    expect(streamChatCompletion.mock.lastCall![0].messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('throws if the stream errors', async () => {
    streamChatCompletion.mockImplementation(async (opts: any) => opts.onError(new Error('model down')));
    await expect(generateAnswer({ model, systemMessages: [], conversation: [], userMessage: 'q' }))
      .rejects.toThrow('model down');
  });
});
