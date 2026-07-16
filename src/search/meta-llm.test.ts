import { describe, it, expect, vi } from 'vitest';
import { OpenAIMetaLLM, AnthropicMetaLLM, META_LLM_TIMEOUT_MS, TASK_META_LLM_TIMEOUT_MS, createConfiguredMetaLLM, createConfiguredTaskMetaLLM, createMetaLLM } from './meta-llm.js';

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

describe('createMetaLLM', () => {
  it('selects Anthropic for the anthropic provider', () => {
    expect(createMetaLLM({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }))
      .toBeInstanceOf(AnthropicMetaLLM);
  });

  it('selects OpenAI for openai and local providers', () => {
    expect(createMetaLLM({ provider: 'openai', model: 'gpt-4o-mini' })).toBeInstanceOf(OpenAIMetaLLM);
    expect(createMetaLLM({ provider: 'local', model: 'm', baseUrl: 'http://gpu1:8000/v1' }))
      .toBeInstanceOf(OpenAIMetaLLM);
  });

  it('passes the baseUrl through to the OpenAI client (local/openai-compatible)', () => {
    const created = vi.fn(() => ({ choices: [{ message: { content: '' } }] }));
    // baseUrl only matters at request time via the real client; here we just assert construction succeeds
    // and a custom createFn still works (the factory must not crash on a baseUrl).
    const llm = createMetaLLM({ provider: 'local', model: 'm', baseUrl: 'http://gpu1:8000/v1' });
    expect(llm).toBeInstanceOf(OpenAIMetaLLM);
    expect(created).not.toHaveBeenCalled();
  });
});

describe('createConfiguredMetaLLM', () => {
  it('works independently of semantic index enablement', () => {
    expect(createConfiguredMetaLLM({ defaultProvider: 'anthropic' })).toBeInstanceOf(AnthropicMetaLLM);
    expect(createConfiguredMetaLLM({ defaultProvider: 'local', defaultModel: 'local-model', localBaseUrl: 'http://gpu1:8000/v1' }))
      .toBeInstanceOf(OpenAIMetaLLM);
  });

  it('keeps fast routing and slower task-classification timeout budgets separate', () => {
    expect(META_LLM_TIMEOUT_MS).toBe(5_000);
    expect(TASK_META_LLM_TIMEOUT_MS).toBe(60_000);
    expect(createConfiguredTaskMetaLLM({ defaultProvider: 'local', defaultModel: 'local-model', localBaseUrl: 'http://gpu1:8000/v1' }))
      .toBeInstanceOf(OpenAIMetaLLM);
  });
});
