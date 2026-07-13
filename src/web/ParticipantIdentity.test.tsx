import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SQUIRL_PARTICIPANT } from '../agents/participants.js';
import type { Participant } from '../agents/types.js';
import { ParticipantIdentity } from './ParticipantIdentity.js';

const cc: Participant = { id: 'cc', kind: 'claude-code', label: 'cc', color: 'magenta', status: 'ready' };
const codex: Participant = { id: 'codex', kind: 'codex', label: 'codex', color: 'orange', status: 'ready' };

describe('ParticipantIdentity', () => {
  it.each([
    [SQUIRL_PARTICIPANT, '#fb923c'],
    [cc, '#e879f9'],
    [codex, '#fb923c'],
  ])('renders a diamond and matching identity label for %s', (participant, color) => {
    const html = renderToStaticMarkup(<ParticipantIdentity participant={participant} text={`@${participant.id}`} />);
    expect(html).toContain('class="participantMark"');
    expect(html).toContain(`background-color:${color}`);
    expect(html).toContain(`color:${color}`);
  });

  it('can render an identity-colored label without a marker', () => {
    const html = renderToStaticMarkup(<ParticipantIdentity participant={cc} text="@cc" marker={false} />);
    expect(html).not.toContain('participantMark');
    expect(html).toContain('color:#e879f9');
  });

  it('can render a marker without a label', () => {
    const html = renderToStaticMarkup(<ParticipantIdentity participant={codex} />);
    expect(html).toContain('class="participantMark"');
    expect(html).not.toContain('color:#fb923c');
  });
});
