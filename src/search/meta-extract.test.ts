import { describe, it, expect, vi } from 'vitest';
import { classifyTurnIntent, deterministicTurnIntentForRequest, extractSearchQueries } from './meta-extract.js';
import type { Message } from '../types.js';

const user = (content: string): Message => ({ id: 'u1', role: 'user', content });
const asst = (content: string): Message => ({ id: 'a1', role: 'assistant', content });

describe('extractSearchQueries', () => {
  it('calls the LLM and parses JSON array of queries', async () => {
    const mockComplete = vi.fn().mockResolvedValue('{"memoryQueries":["docker setup","chroma config"],"research":{"needed":false,"reason":"none","query":""}}');

    const queries = await extractSearchQueries(
      [user('How do I set up Chroma?'), asst('Use docker compose...')],
      'Can I change the port?',
      { complete: mockComplete },
    );

    expect(queries).toEqual(['docker setup', 'chroma config']);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0]![0];
    expect(callArgs.systemPrompt).toContain('search quer');
  });

  it('returns empty array if LLM returns invalid JSON', async () => {
    const mockComplete = vi.fn().mockResolvedValue('not json at all');
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual([]);
  });

  it('returns empty array if LLM call throws', async () => {
    const mockComplete = vi.fn().mockRejectedValue(new Error('network error'));
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual([]);
  });

  it('filters out non-string entries from memory queries', async () => {
    const mockComplete = vi.fn().mockResolvedValue('{"memoryQueries":["valid",123,null,"also valid"],"research":{"needed":false,"reason":"none"}}');
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual(['valid', 'also valid']);
  });

  it('forces public-benefit research and stable STT/TTS skips', async () => {
    const llm = { complete: vi.fn().mockResolvedValue('{"memoryQueries":["cards"],"research":{"needed":false,"reason":"none"}}') };
    await expect(classifyTurnIntent([], 'Can I use my BIC card for EBT?', llm)).resolves.toMatchObject({ research: { needed: true, reason: 'high-stakes' } });
    llm.complete.mockResolvedValueOnce('{"memoryQueries":["speech systems"],"research":{"needed":true,"reason":"uncertain","query":"STT TTS"}}');
    await expect(classifyTurnIntent([], 'What is STT versus TTS?', llm)).resolves.toMatchObject({ research: { needed: false, reason: 'none' } });
  });

  it('preserves deterministic research when the classifier fails', async () => {
    const result = await classifyTurnIntent([], 'Verify the latest rule online', { complete: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(result.research).toMatchObject({ needed: true, reason: 'explicit' });
  });

  it.each([
    ["What's the hottest topic in the news right now?", 'freshness'],
    ['What is currently trending?', 'freshness'],
    ['When will version 14 reach general availability?', 'freshness'],
    ['What is the latest price?', 'freshness'],
    ["What's tomorrow's schedule and weather forecast?", 'freshness'],
    ['What was the final score and current standings?', 'freshness'],
    ['Verify this rule online', 'explicit'],
    ['Can I use my BIC card for EBT?', 'high-stakes'],
  ])('routes changing information synchronously: %s', (request, reason) => {
    expect(deterministicTurnIntentForRequest(request).research).toMatchObject({ needed: true, reason });
  });

  it('keeps stable explanations offline and normalizes a raw memory fallback', () => {
    const intent = deterministicTurnIntentForRequest('  What   is STT versus TTS?  ');
    expect(intent.research).toEqual({ needed: false, reason: 'none' });
    expect(intent.memoryQueries).toEqual(['What is STT versus TTS?']);
  });

  it.each([
    ['Can I use my BIC card for EBT?', []],
    ['What is STT versus TTS?', []],
    ['How do I fix a TypeScript error?', []],
    ['Write me a short explanation of embeddings', []],
    ['Inspect the files in this workspace', ['read_file', 'list_files']],
    ['Please implement this plan', ['read_file', 'list_files', 'write_file']],
    ['Run the tests', ['run_command']],
    ['Fix the parser and run the build', ['read_file', 'list_files', 'write_file', 'run_command']],
  ])('derives workspace authorization only from an explicit newest request: %s', async (request, allowed) => {
    const llm = { complete: vi.fn().mockResolvedValue(JSON.stringify({
      memoryQueries: [], research: { needed: false, reason: 'none' },
      workspaceTools: { allowed: ['read_file', 'write_file', 'run_command', 'list_files'], reason: 'explicit-mixed' },
    })) };
    await expect(classifyTurnIntent([], request, llm)).resolves.toMatchObject({ workspaceTools: { allowed } });
  });
});
