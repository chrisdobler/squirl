import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actionDecisionFromToolArguments, clearModelActionCapabilityCache, probeModelActionCapabilities } from './action-model.js';
import { parseSquirlActionDecision } from './actions.js';

describe('model action capabilities', () => {
  beforeEach(() => clearModelActionCapabilityCache());

  it('selects JSON-schema actions when vLLM rejects tool calling', async () => {
    const create = vi.fn(async (params: Record<string, unknown>) => {
      if (params.tools) throw new Error('tool_choice="required" requires --tool-call-parser to be set');
      return { choices: [{ message: { content: '{"decision":"respond","targetId":"","task":"","context":"","successCriteria":""}' } }] };
    });
    await expect(probeModelActionCapabilities({
      id: 'local-model', label: 'local-model', provider: 'local', baseUrl: 'http://gpu1/v1',
    }, create)).resolves.toEqual({ nativeToolCalls: false, structuredOutput: true });
  });

  it('keeps native tools and structured output as independent capabilities', async () => {
    const create = vi.fn(async (params: Record<string, unknown>) => params.tools
      ? { choices: [{ message: { tool_calls: [{ function: { name: 'propose_handoff', arguments: '{}' } }] } }] }
      : { choices: [{ message: { content: 'not-json' } }] });
    await expect(probeModelActionCapabilities({
      id: 'local-model', label: 'local-model', provider: 'local', baseUrl: 'http://gpu1/v1',
    }, create)).resolves.toEqual({ nativeToolCalls: true, structuredOutput: false });
  });

  it('maps native tool arguments and JSON-schema output to the same action', () => {
    const agents = [{ id: 'pi', connected: true }];
    const fields = { targetId: 'pi', task: 'Research it', context: 'Current request', successCriteria: 'Cited answer' };
    const native = parseSquirlActionDecision(actionDecisionFromToolArguments(JSON.stringify(fields)), agents);
    const structured = parseSquirlActionDecision({ decision: 'handoff', ...fields }, agents);
    expect(native).toEqual(structured);
  });
});
