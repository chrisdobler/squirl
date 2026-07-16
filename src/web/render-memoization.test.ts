import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Participant } from '../agents/types.js';
import type { Message } from '../types.js';
import { AgentActivityCardView } from './AgentActivityCardView.js';
import { areMarkdownContentPropsEqual } from './MarkdownContent.js';
import {
  AgentInteractionPrompt,
  ChatActivity,
  areConversationHistoryPropsEqual,
  areMessageViewPropsEqual,
  areTurnViewPropsEqual,
  MessageView,
  type ConversationHistoryProps,
  type MessageViewProps,
  type TurnViewProps,
} from './renderer.js';

const participant: Participant = {
  id: 'squirl', kind: 'local-llm', label: 'squirl', color: 'orange', status: 'ready',
};
const registry = new Map([[participant.id, participant]]);
const rewindCandidateIds = new Set<string>();
const message: Message = { id: 'message-1', role: 'assistant', content: '**hello**' };

describe('chat render memoization', () => {
  it('keeps the full conversation history stable across composer-only renders', () => {
    const props: ConversationHistoryProps = {
      messages: [message], showThinking: false, registry, rewindCandidateIds,
    };

    expect(areConversationHistoryPropsEqual(props, { ...props })).toBe(true);
    expect(areConversationHistoryPropsEqual(props, { ...props, messages: [...props.messages] })).toBe(false);
    expect(areConversationHistoryPropsEqual(props, { ...props, showThinking: true })).toBe(false);
    expect(areConversationHistoryPropsEqual(props, { ...props, registry: new Map(registry) })).toBe(false);
    expect(areConversationHistoryPropsEqual(props, { ...props, rewindCandidateIds: new Set(['message-1']) })).toBe(false);
    expect(areConversationHistoryPropsEqual(props, { ...props, selectedMessageId: 'message-1' })).toBe(false);
  });

  it('reuses unchanged turns when a streaming update changes another turn', () => {
    const props: TurnViewProps = {
      turn: [message], showThinking: false, registry, rewindCandidateIds,
    };

    expect(areTurnViewPropsEqual(props, { ...props, turn: [...props.turn] })).toBe(true);
    expect(areTurnViewPropsEqual(props, { ...props, turn: [{ ...message, content: 'updated' }] })).toBe(false);
    expect(areTurnViewPropsEqual(props, { ...props, turn: [...props.turn, { id: 'message-2', role: 'user', content: 'next' }] })).toBe(false);
    expect(areTurnViewPropsEqual(props, { ...props, showThinking: true })).toBe(false);
    expect(areTurnViewPropsEqual(props, { ...props, selectedMessageId: 'message-1' })).toBe(false);
  });

  it('invalidates only message presentation changes and skips identical Markdown', () => {
    const props: MessageViewProps = {
      message, showThinking: false, registry, rewindCandidate: false, rewindSelected: false, showMeta: true,
    };

    expect(areMessageViewPropsEqual(props, { ...props })).toBe(true);
    expect(areMessageViewPropsEqual(props, { ...props, message: { ...message, content: 'updated' } })).toBe(false);
    expect(areMessageViewPropsEqual(props, { ...props, rewindSelected: true })).toBe(false);
    expect(areMessageViewPropsEqual(props, { ...props, showMeta: false })).toBe(false);
    expect(areMarkdownContentPropsEqual({ children: '**hello**' }, { children: '**hello**' })).toBe(true);
    expect(areMarkdownContentPropsEqual({ children: '**hello**' }, { children: '**updated**' })).toBe(false);
  });

  it('renders animated dots instead of an underscore before streaming text arrives', () => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, content: '', isStreaming: true },
      showThinking: false,
      registry,
    }));

    expect(html).toContain('class="streamingDots"');
    expect(html).toContain('aria-label="Preparing response"');
    expect(html).toContain('<strong>streaming</strong>');
    expect(html).not.toContain('>_</');
  });

  it('omits a completed contentless assistant tool-call placeholder', () => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, content: '', isStreaming: false, toolCalls: [{ id: 'call-1', name: 'run_command', arguments: '{}' }] },
      showThinking: false,
      registry,
    }));
    expect(html).toBe('');
  });

  it('renders durable handoff delivery truth in message metadata', () => {
    const sent = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, handoff: { targetId: 'codex-squirl', requestId: 'handoff-1', state: 'dispatched' } },
      showThinking: false, registry, showMeta: true,
    }));
    const proposed = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, handoff: { targetId: 'codex-squirl', requestId: 'proposal-1', state: 'proposed' } },
      showThinking: false, registry, showMeta: true,
    }));
    expect(sent).toContain('sent to @codex-squirl');
    expect(proposed).toContain('not sent · @codex-squirl');
  });

  it('labels a retained partial response as interrupted with retry available', () => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, content: 'Partial answer', responseState: 'interrupted' },
      showThinking: false, registry, showMeta: true,
    }));
    expect(html).toContain('Partial answer');
    expect(html).toContain('interrupted · retry available');
    expect(html).not.toContain('<strong>streaming</strong>');
  });

  it.each([
    [92, 'high'],
    [79, 'medium'],
    [49, 'low'],
  ])('renders a %s%% Squirl confidence badge with %s tone', (confidence, tone) => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, responseMeta: { model: 'local', confidence } },
      showThinking: false, registry, showMeta: true,
    }));
    expect(html).toContain(`confidenceBadge ${tone}`);
    expect(html).toContain(`aria-label="${confidence}% confidence"`);
    expect(html).toContain(`>${confidence}%<`);
  });

  it('renders a confidence loader while asynchronous assessment is pending', () => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, responseMeta: { model: 'local', confidenceState: 'pending' } },
      showThinking: false, registry, showMeta: true,
    }));
    expect(html).toContain('confidenceBadge pending');
    expect(html).toContain('confidenceSpinner');
    expect(html).toContain('Assessing confidence');
  });

  it('renders unavailable confidence without adding badges to legacy or specialist messages', () => {
    const unavailable = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, responseMeta: { model: 'local', confidence: null } },
      showThinking: false, registry, showMeta: true,
    }));
    const legacy = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, responseMeta: { model: 'local' } },
      showThinking: false, registry, showMeta: true,
    }));
    const specialist = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, participantId: 'cc-squirl-fable', responseMeta: { model: 'claude', confidence: 40 } },
      showThinking: false, registry, showMeta: true,
    }));
    expect(unavailable).toContain('confidenceBadge unavailable');
    expect(unavailable).toContain('confidence ?');
    expect(legacy).not.toContain('confidenceBadge');
    expect(specialist).not.toContain('confidenceBadge');
  });

  it('renders web source count separately from answer confidence', () => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, content: '[Agency](https://agency.gov/a) and [Program](https://program.gov/b)', responseMeta: { model: 'local', confidence: 86, research: {
        queries: ['current answer'],
        sources: [
          { title: 'Agency', url: 'https://agency.gov/a', domain: 'agency.gov', fetched: true },
          { title: 'Program', url: 'https://program.gov/b', domain: 'program.gov', fetched: true },
        ], citedSourceCount: 2,
      } } },
      showThinking: false, registry, showMeta: true,
    }));
    expect(html).toContain('86%');
    expect(html).toContain('class="researchSourceBadge"');
    expect(html).toContain('2 sources');
  });

  it('renders a durable activity card with aggregate progress', () => {
    const html = renderToStaticMarkup(React.createElement(MessageView, {
      message: {
        id: 'activity-job-1', role: 'activity', content: 'Deep research', participantId: 'cc-squirl-fable',
        activity: {
          version: 1, kind: 'research', state: 'running', title: 'deep-research is running',
          participantId: 'cc-squirl-fable', startedAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:01:00Z',
          progress: { completed: 14, active: 8 }, actions: ['check-status'], collapsed: false,
          workers: [{ id: 'agent-12345678', label: 'Adversarial Claim Verifier (voter 1/3)', state: 'running' }],
        },
      },
      showThinking: false, registry,
    }));
    expect(html).toContain('agentActivityCard research');
    expect(html).toContain('14 completed');
    expect(html).toContain('8 active');
    expect(html).toContain('Running agents (1)');
    expect(html).toContain('Adversarial Claim Verifier (voter 1/3)');
    expect(html).toContain('Check status');
  });

  it('renders live pipeline status without a routine card', () => {
    const html = renderToStaticMarkup(React.createElement(ChatActivity, { label: 'Preparing context…' }));
    expect(html).toContain('class="chatActivity"');
    expect(html).toContain('Preparing context…');
    expect(html).not.toContain('agentActivityCard');
  });

  it('renders normalized semantic progress inside the transient activity bubble', () => {
    const html = renderToStaticMarkup(React.createElement(ChatActivity, {
      label: 'Classifying…',
      semanticProgress: { turnId: 'turn-1', stage: 'turn-intent', label: 'Turn intent', state: 'complete', output: { memoryQueries: ['prior discussion'] } },
    }));
    expect(html).toContain('chatActivity--semantic');
    expect(html).toContain('Turn intent');
    expect(html).toContain('memoryQueries');
    expect(html).not.toContain('Classifying…');
  });

  it('renders a plain-language routing result without diagnostic JSON', () => {
    const html = renderToStaticMarkup(React.createElement(ChatActivity, {
      label: 'Choosing who should handle this…',
      semanticProgress: {
        turnId: 'turn-1', stage: 'action-plan', label: 'Request routing', state: 'complete',
        summary: 'Squirl will handle this request.', output: { kind: 'none' },
      },
    }));
    expect(html).toContain('Request routing');
    expect(html).toContain('Squirl will handle this request.');
    expect(html).not.toContain('kind');
  });

  it('renders a quiet inspect control outside the live status region', () => {
    const html = renderToStaticMarkup(React.createElement(ChatActivity, { label: 'Classifying…', onInspect: () => undefined }));
    expect(html).toContain('aria-label="Inspect Squirl execution"');
    expect(html).toContain('class="chatActivityStatus" role="status"');
    expect(html).toContain('>inspect</button>');
  });

  it('renders a quiet retained inspect link only when a Squirl response has a trace', () => {
    const traced = renderToStaticMarkup(React.createElement(MessageView, {
      message, showThinking: false, registry, inspectTraceId: 'turn-1', onInspectTrace: () => undefined,
    }));
    const untraced = renderToStaticMarkup(React.createElement(MessageView, {
      message, showThinking: false, registry,
    }));
    const specialist = renderToStaticMarkup(React.createElement(MessageView, {
      message: { ...message, participantId: 'codex' }, showThinking: false,
      registry: new Map([...registry, ['codex', { id: 'codex', kind: 'codex', label: 'Codex', color: 'blue', status: 'ready' } as Participant]]),
      inspectTraceId: 'turn-1', onInspectTrace: () => undefined,
    }));
    expect(traced).toContain('aria-label="Inspect this Squirl execution"');
    expect(traced).toContain('class="messageTraceInspect"');
    expect(untraced).not.toContain('messageTraceInspect');
    expect(specialist).not.toContain('messageTraceInspect');
  });

  it('renders permissions as a compact prompt without a generic response field', () => {
    const html = renderToStaticMarkup(React.createElement(AgentInteractionPrompt, {
      participantId: 'cc-squirl-fable',
      request: {
        id: 'permission-1', method: 'permission', title: 'cc-squirl-fable wants to use Bash',
        message: 'Summarize workflow run metadata', toolName: 'Bash', input: '{"command":"python3 -c ..."}',
        sessionScope: { key: 'python', label: 'Always allow python3 for this session' },
      },
      onRespond: async () => undefined,
    }));
    expect(html).toContain('agentInteractionPrompt permission');
    expect(html).toContain('Summarize workflow run metadata');
    expect(html).toContain('Review request');
    expect(html).toContain('Allow once');
    expect(html).toContain('Always allow this session');
    expect(html).not.toContain('Type your response');
  });

  it('uses the compact permission fallback for a durable pinned activity', () => {
    const html = renderToStaticMarkup(React.createElement(AgentActivityCardView, {
      pinned: true,
      message: {
        id: 'activity-permission-1', role: 'activity', content: 'Permission', participantId: 'cc-squirl-fable',
        activity: {
          version: 1, kind: 'input', state: 'blocked', title: 'cc-squirl-fable needs your input',
          summary: 'cc-squirl-fable wants to use Bash', detail: 'Summarize workflow run metadata',
          participantId: 'cc-squirl-fable', phase: 'Permission · Bash', updatedAt: '2026-07-14T21:52:17Z',
          actions: ['approve', 'reject', 'respond'],
          provider: { kind: 'claude-code', interactionId: 'permission-1', interactionMethod: 'permission' },
        },
      },
    }));
    expect(html).toContain('agentInteractionPrompt permission activityPermissionPrompt');
    expect(html).toContain('Summarize workflow run metadata');
    expect(html).toContain('Allow once');
    expect(html).not.toContain('Respond');
    expect(html).not.toContain('Type your response');
  });
});
