import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HandoffConfirmationBar } from './renderer.js';

describe('HandoffConfirmationBar', () => {
  it('renders a system prompt above the composer with clickable Yes and No controls', () => {
    const html = renderToStaticMarkup(React.createElement(HandoffConfirmationBar, {
      interaction: {
        id: 'confirm-1', kind: 'handoff-confirmation', originalRequest: 'Ask Pi to review this',
        createdAt: '2026-07-15T20:00:00.000Z', expiresAt: '2026-07-15T20:10:00.000Z',
        pending: {
          id: 'confirm-1', targetIds: ['pi'], task: 'Review the implementation', originalRequest: 'Ask Pi to review this',
          createdAt: '2026-07-15T20:00:00.000Z', expiresAt: '2026-07-15T20:10:00.000Z',
        },
      },
      busy: false,
      onRespond: () => undefined,
    }));
    expect(html).toContain('class="systemInteractionBar"');
    expect(html).toContain('Send to @pi?');
    expect(html).toContain('Review the implementation');
    expect(html).toMatch(/<button[^>]*>No<\/button>/);
    expect(html).toMatch(/<button[^>]*>Yes<\/button>/);
    expect(html).not.toContain('reply yes or no');
  });
});
