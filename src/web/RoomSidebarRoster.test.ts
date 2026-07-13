import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Participant } from '../agents/types.js';
import { ContextMatrix } from './ContextMatrix.js';
import { ContextPreviewCard, RoomSidebarRoster } from './RoomSidebarRoster.js';
import type { ParticipantContextPreview } from './types.js';

const participants: Participant[] = [
  { id: 'user', kind: 'user', label: 'you', color: 'cyan' },
  { id: 'squirl', kind: 'local-llm', label: 'squirl', color: 'green' },
  { id: 'codex', kind: 'codex', label: 'reviewer', color: 'magenta', status: 'busy' },
];

describe('RoomSidebarRoster', () => {
  it('renders every room agent, excludes the user, and exposes compact-width classes', () => {
    const html = renderToStaticMarkup(React.createElement(RoomSidebarRoster, {
      participants,
      loadPreview: async () => { throw new Error('not called during static render'); },
    }));
    expect(html).toContain('In this room');
    expect(html).toContain('@squirl');
    expect(html).toContain('@codex');
    expect(html).not.toContain('@user');
    expect(html).toContain('roomRailIdentity');
    expect(html).toContain('roomRailText');
    expect(html).toContain('aria-label="squirl @squirl · ready local"');
  });

  it('renders sanitized context metadata and an accessible matrix card', () => {
    const preview: ParticipantContextPreview = {
      participantId: 'codex', modelId: 'gpt-test', source: 'codex-session', fidelity: 'inspected', capturedAt: '2026-01-01T00:00:00Z',
      usedTokens: 50, contextWindow: 100, buckets: { system: 10, memory: 0, files: 10, messages: 30 },
      discs: Array.from({ length: 100 }, (_, index) => index < 50 ? 'messages' as const : 'available' as const),
    };
    const html = renderToStaticMarkup(React.createElement(ContextPreviewCard, {
      participant: participants[2]!, preview, loading: false, position: { left: 10, top: 20 },
    }));
    expect(html).toContain('gpt-test');
    expect(html).toContain('50 / 100 tokens');
    expect(html).toContain('reviewer context matrix preview');
    expect(html).toContain('contextDiscGrid compact');
  });
});

describe('ContextMatrix', () => {
  it('shares accessible interactive cells with the full context explorer', () => {
    const html = renderToStaticMarkup(React.createElement(ContextMatrix, {
      label: 'Navigate test context',
      cells: [{ index: 0, kind: 'system', ariaLabel: 'System cell' }, { index: 1, kind: 'available', disabled: true }],
      onSelect: () => undefined,
    }));
    expect(html).toContain('aria-label="Navigate test context"');
    expect(html).toContain('aria-label="System cell"');
    expect(html).toContain('class="disc available"');
  });
});
