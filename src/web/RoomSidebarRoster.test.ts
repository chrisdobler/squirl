import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Participant } from '../agents/types.js';
import { ContextMatrix } from './ContextMatrix.js';
import { ContextPreviewCard, CurrentTasks, RoomSidebarRoster, sidebarDestination } from './RoomSidebarRoster.js';
import type { ParticipantContextPreview } from './types.js';

const healthEntries = [
  { id: 'model', label: 'model', state: 'ok' as const, latencyMs: 12 },
  { id: 'embedder', label: 'embedder', state: 'degraded' as const, detail: 'warming' },
  { id: 'vectordb', label: 'vector db', state: 'down' as const, detail: 'connection refused' },
  { id: 'meta', label: 'query model', state: 'unknown' as const },
];

const participants: Participant[] = [
  { id: 'user', kind: 'user', label: 'you', color: 'cyan' },
  { id: 'squirl', kind: 'local-llm', label: 'squirl', color: 'green' },
  { id: 'codex', kind: 'codex', label: 'reviewer', color: 'magenta', status: 'busy' },
];

describe('RoomSidebarRoster', () => {
  it('renders a non-interactive current-task list with stale state and participant context', () => {
    const html = renderToStaticMarkup(React.createElement(CurrentTasks, { activity: {
      status: 'stale', generatedAt: '2026-07-13T18:00:00.000Z',
      tasks: [{ id: 'task-1', title: 'Build inferred task feed', lastActiveAt: new Date(Date.now() - 120_000).toISOString(), participantIds: ['codex'], evidenceIds: ['u1'] }],
    } }));
    expect(html).toContain('Current tasks');
    expect(html).toContain('Build inferred task feed');
    expect(html).toContain('@codex');
    expect(html).toContain('stale');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a');
  });

  it('renders every room agent, excludes the user, and exposes compact-width classes', () => {
    const html = renderToStaticMarkup(React.createElement(RoomSidebarRoster, {
      participants,
      healthEntries,
      squirlDependenciesExpanded: true,
      onSquirlDependenciesExpandedChange: () => undefined,
      onSelectParticipant: () => undefined,
      loadPreview: async () => { throw new Error('not called during static render'); },
    }));
    expect(html).toContain('In this room');
    expect(html).toContain('@squirl');
    expect(html).toContain('@codex');
    expect(html).not.toContain('@user');
    expect(html).toContain('roomRailIdentity');
    expect(html).toContain('roomRailText');
    expect(html).toContain('aria-label="squirl @squirl · ready local"');
    expect(html).toContain('data-destination="model"');
    expect(html).toContain('data-destination="agent"');
    expect(html).toContain('aria-label="Collapse Squirl dependencies"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="squirl-dependency-tree"');
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toMatch(/<\/button><button type="button" class="roomRailDisclosure"/);
    expect(html).toContain('aria-label="model: ok"');
    expect(html).toContain('aria-label="embedder: degraded · warming"');
    expect(html).toContain('aria-label="vector db: down · connection refused"');
    expect(html).toContain('aria-label="query model: unknown"');
    expect(html.match(/squirlDependencyTree/g)).toHaveLength(1);
  });

  it('collapses only Squirl dependencies while retaining the disclosure control', () => {
    const html = renderToStaticMarkup(React.createElement(RoomSidebarRoster, {
      participants,
      healthEntries,
      squirlDependenciesExpanded: false,
      onSquirlDependenciesExpandedChange: () => undefined,
      onSelectParticipant: () => undefined,
      loadPreview: async () => { throw new Error('not called during static render'); },
    }));
    expect(html).toContain('aria-label="Expand Squirl dependencies"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('squirlDependencyTree');
    expect(html).not.toContain('aria-label="model: ok"');
  });

  it('routes Squirl to Model and CLI participants to Agents', () => {
    expect(sidebarDestination(participants[1]!)).toBe('model');
    expect(sidebarDestination(participants[2]!)).toBe('agent');
  });

  it('renders sanitized context metadata and an accessible matrix card', () => {
    const preview: ParticipantContextPreview = {
      participantId: 'codex', modelId: 'gpt-test', source: 'codex-session', fidelity: 'inspected', capturedAt: '2026-01-01T00:00:00Z',
      matrixMode: 'usage',
      usedTokens: 50, contextWindow: 100, buckets: { system: 10, memory: 0, files: 10, messages: 30 },
      discs: Array.from({ length: 100 }, (_, index) => index < 50 ? 'messages' as const : 'available' as const),
    };
    const html = renderToStaticMarkup(React.createElement(ContextPreviewCard, {
      participant: participants[2]!, preview, loading: false, position: { left: 10, top: 20 },
    }));
    expect(html).toContain('gpt-test');
    expect(html).toContain('50 / 100 tokens');
    expect(html).toContain('last turn input');
    expect(html).toContain('reviewer context matrix preview');
    expect(html).toContain('contextDiscGrid compact neutral');
    expect(html).toContain('Usage only · Codex does not expose category-level context.');
    expect(html).toContain('available 50');
  });

  it('shows inspected category token details for Claude Code', () => {
    const preview: ParticipantContextPreview = {
      participantId: 'claude', modelId: 'claude-test', source: 'claude-session', fidelity: 'inspected', matrixMode: 'categorized', capturedAt: '2026-01-01T00:00:00Z',
      usedTokens: 60, contextWindow: 100, buckets: { system: 10, memory: 5, files: 15, messages: 30 },
      discs: Array.from({ length: 100 }, (_, index) => index < 60 ? 'messages' as const : 'available' as const),
    };
    const claude: Participant = { id: 'claude', kind: 'claude-code', label: 'writer', color: 'blue', status: 'ready' };
    const html = renderToStaticMarkup(React.createElement(ContextPreviewCard, {
      participant: claude, preview, loading: false, position: { left: 10, top: 20 },
    }));
    expect(html).toContain('system 10');
    expect(html).toContain('recalled memory 5');
    expect(html).toContain('files 15');
    expect(html).toContain('messages 30');
    expect(html).toContain('available 40');
    expect(html).not.toContain('contextDiscGrid compact neutral');
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
