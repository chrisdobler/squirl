import { describe, expect, it } from 'vitest';
import { parseSquirlActionDecision } from './actions.js';

const agents = [{ id: 'pi', connected: true }, { id: 'offline', connected: false }];

describe('structured Squirl actions', () => {
  it('validates a handoff without accepting model-authored authorization', () => {
    expect(parseSquirlActionDecision({
      decision: 'handoff', targetId: 'pi', task: 'Answer the question', context: 'BIC card', successCriteria: 'Give a clear answer',
      authorization: 'explicit',
    } as any, agents)).toEqual({ type: 'action', action: {
      type: 'handoff', targetId: 'pi', task: 'Answer the question', context: 'BIC card', successCriteria: 'Give a clear answer',
    } });
  });

  it.each([
    { decision: 'respond' },
    { decision: 'handoff', targetId: 'missing', task: 'work' },
    { decision: 'handoff', targetId: 'offline', task: 'work' },
    { decision: 'handoff', targetId: 'pi', task: '' },
  ])('rejects malformed or unavailable action %#', (raw) => {
    expect(parseSquirlActionDecision(raw, agents)).toEqual({ type: 'respond' });
  });
});
