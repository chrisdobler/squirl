import { describe, expect, it, vi } from 'vitest';
import { assessSquirlAnswer, parseAnswerAssessment } from './answer-assessment.js';
import type { MetaLLM } from '../search/meta-extract.js';

const agents = [
  { id: 'pi', label: 'Pi', connected: true, specialty: 'general investigation' },
  { id: 'offline', connected: false, specialty: 'research' },
];

function llm(...responses: string[]): MetaLLM & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => responses.shift() ?? '');
  return { complete };
}

describe('answer confidence assessment', () => {
  it('parses a percentage and validated connected handoff action', () => {
    expect(parseAnswerAssessment(JSON.stringify({
      confidence: 63, targetId: 'pi', task: 'Verify the answer', context: 'Rules vary by state', successCriteria: 'Give a current sourced answer',
    }), agents)).toEqual({
      confidence: 63,
      action: { type: 'handoff', targetId: 'pi', task: 'Verify the answer', context: 'Rules vary by state', successCriteria: 'Give a current sourced answer' },
    });
  });

  it.each([-1, 101, 72.5, '80'])('rejects an invalid confidence value: %s', (confidence) => {
    expect(parseAnswerAssessment(JSON.stringify({ confidence, targetId: '', task: '', context: '', successCriteria: '' }), agents)).toBeNull();
  });

  it('keeps valid confidence but rejects unknown, disconnected, or incomplete targets', () => {
    for (const value of [
      { confidence: 40, targetId: 'missing', task: 'Verify' },
      { confidence: 40, targetId: 'offline', task: 'Verify' },
      { confidence: 40, targetId: 'pi', task: '' },
    ]) expect(parseAnswerAssessment(JSON.stringify(value), agents)).toEqual({ confidence: 40 });
  });

  it('retries malformed output once and returns the repaired assessment', async () => {
    const model = llm('not json', '{"confidence":79,"targetId":"","task":"","context":"","successCriteria":""}');
    await expect(assessSquirlAnswer('question', 'answer', agents, model)).resolves.toEqual({ confidence: 79 });
    expect(model.complete).toHaveBeenCalledTimes(2);
  });

  it('passes bounded web provenance into the evidence-aware assessment', async () => {
    const model = llm('{"confidence":88,"targetId":"","task":"","context":"","successCriteria":""}');
    await assessSquirlAnswer('current question', 'sourced answer', agents, model, {
      queries: ['official current guidance'],
      sources: [{ title: 'Agency', url: 'https://agency.gov/guidance', domain: 'agency.gov', fetched: true }],
    });
    const input = JSON.parse(model.complete.mock.calls[0]![0].messages[0].content);
    expect(input.research.sources[0]).toMatchObject({ domain: 'agency.gov', fetched: true });
    expect(model.complete.mock.calls[0]![0].systemPrompt).toContain('Tool use alone earns no confidence increase');
  });

  it('returns unavailable after two malformed responses or a provider failure', async () => {
    await expect(assessSquirlAnswer('question', 'answer', agents, llm('bad', 'still bad'))).resolves.toEqual({ confidence: null });
    const failing: MetaLLM = { complete: async () => { throw new Error('offline'); } };
    await expect(assessSquirlAnswer('question', 'answer', agents, failing)).resolves.toEqual({ confidence: null });
  });
});
