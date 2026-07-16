import { describe, expect, it } from 'vitest';
import { chatActivityLabel, participantActivityLabel, withoutRoutineAssignmentCards } from './chat-activity.js';
import type { Message } from '../types.js';

describe('chatActivityLabel', () => {
  it('shows feedback before the first pipeline event', () => {
    expect(chatActivityLabel(null)).toBe('Preparing context…');
  });

  it('groups retrieval stages under a stable label', () => {
    expect(chatActivityLabel({ stage: 'memory-query' })).toBe('Searching memory…');
    expect(chatActivityLabel({ stage: 'memory-embed' })).toBe('Searching memory…');
    expect(chatActivityLabel({ stage: 'vectordb' })).toBe('Searching memory…');
  });

  it('distinguishes model wait from generation', () => {
    expect(chatActivityLabel({ stage: 'model-connect' })).toBe('Waiting for model…');
    expect(chatActivityLabel({ stage: 'model-stream' })).toBe('Generating response…');
  });
});

describe('withoutRoutineAssignmentCards', () => {
  const messages: Message[] = [
    { id: 'memory', role: 'tool', toolCallId: 'memory', toolName: 'memory', content: 'Found 1 memory', participantId: 'squirl' },
    {
      id: 'assignment', role: 'activity', content: 'Working', participantId: 'squirl',
      activity: {
        version: 1, kind: 'assignment', state: 'running', title: '@squirl is working',
        participantId: 'squirl', turnId: 'turn-1', updatedAt: '2026-07-15T12:00:00.000Z',
        actions: ['cancel'], collapsed: true,
      },
    },
    {
      id: 'research', role: 'activity', content: 'Researching', participantId: 'squirl',
      activity: {
        version: 1, kind: 'research', state: 'running', title: 'Researching',
        participantId: 'squirl', turnId: 'turn-1', updatedAt: '2026-07-15T12:00:00.000Z',
        actions: ['check-status'], collapsed: false,
      },
    },
    {
      id: 'activity-turn-legacy', role: 'activity', content: 'Interrupted', participantId: 'squirl',
      activity: {
        version: 1, kind: 'failure', state: 'stalled', title: '@squirl was interrupted',
        participantId: 'squirl', turnId: 'legacy', updatedAt: '2026-07-15T12:00:00.000Z',
        actions: ['retry', 'cancel'], collapsed: false,
      },
    },
  ];

  it('hides current and legacy routine turn cards while preserving substantial activity order', () => {
    expect(withoutRoutineAssignmentCards(messages).map((message) => message.id)).toEqual(['memory', 'research']);
  });
});

describe('participantActivityLabel', () => {
  it('does not attribute an external agent turn to Squirl memory retrieval', () => {
    expect(participantActivityLabel('cc', 'Claude Code', undefined, { stage: 'memory-query' })).toBe('Claude Code is working…');
  });

  it('keeps real Squirl pipeline labels', () => {
    expect(participantActivityLabel('squirl', 'Squirl', undefined, { stage: 'memory-query' })).toBe('Searching memory…');
  });
});
