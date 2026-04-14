import { describe, it, expect, vi } from 'vitest';
import { OpenAIMetaLLM, AnthropicMetaLLM } from './meta-llm.js';

describe('OpenAIMetaLLM', () => {
  it('calls OpenAI chat completions and returns content', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["q1", "q2"]' } }],
    });
    const llm = new OpenAIMetaLLM({ model: 'gpt-4o-mini', createFn: mockCreate });

    const result = await llm.complete({
      systemPrompt: 'generate queries',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toBe('["q1", "q2"]');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
  });
});

describe('AnthropicMetaLLM', () => {
  it('calls Anthropic messages and returns text', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '["q1"]' }],
    });
    const llm = new AnthropicMetaLLM({ model: 'claude-haiku-4-5-20251001', createFn: mockCreate });

    const result = await llm.complete({
      systemPrompt: 'generate queries',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toBe('["q1"]');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
      system: 'generate queries',
    }));
  });
});
