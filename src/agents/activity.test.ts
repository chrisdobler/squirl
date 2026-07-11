import { describe, expect, it } from 'vitest';
import { deriveAgentActivity, formatAgentActivity } from './activity.js';
import type { Participant } from './types.js';
import type { Message } from '../types.js';

const participants: Participant[] = [
  { id: 'user', label: 'you', kind: 'user', color: 'cyan' },
  { id: 'squirl', label: 'squirl', kind: 'local-llm', color: 'green' },
  { id: 'cc', label: 'Cece', kind: 'claude-code', color: 'yellow', status: 'busy', specialty: 'frontend' },
];

describe('agent activity ledger', () => {
  it('tracks the latest assignment and recent outputs by participant identity', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'review the layout', participantId: 'cc' },
      { id: 'a1', role: 'assistant', content: 'I reviewed the layout.', participantId: 'cc' },
      { id: 'u2', role: 'user', content: 'now fix the mobile header', participantId: 'cc' },
      { id: 'a2', role: 'assistant', content: 'Working on the mobile header.', participantId: 'cc' },
    ];
    const activity = deriveAgentActivity(participants, messages);
    expect(activity[0]).toMatchObject({ id: 'cc', label: 'Cece', status: 'busy', latestAssignment: 'now fix the mobile header' });
    expect(activity[0]?.assignmentHistory).toEqual(['review the layout', 'now fix the mobile header']);
    expect(formatAgentActivity(activity)).toContain('Recent work: I reviewed the layout. | Working on the mobile header.');
  });

  it('reports agents with no recorded assignment without inventing one', () => {
    expect(formatAgentActivity(deriveAgentActivity(participants, []))).toContain('Current assignment: none recorded');
  });
});
