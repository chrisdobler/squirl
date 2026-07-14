import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalendarSelectionModal, GoogleSignInModal } from './renderer.js';

describe('Google onboarding', () => {
  it('explains controlled inferred-task writes and requests a client id when needed', () => {
    const html = renderToStaticMarkup(React.createElement(GoogleSignInModal, { clientConfigured: false, onDismiss: () => undefined, onSignIn: async () => undefined }));
    expect(html).toContain('Sign in with Google');
    expect(html).toContain('Squirl-owned inferred-task events');
    expect(html).toContain('Installed-app OAuth client ID');
    expect(html).toContain('Not now');
  });

  it('shows the signed-in profile and every available calendar for selection', () => {
    const html = renderToStaticMarkup(React.createElement(CalendarSelectionModal, {
      activity: {
        status: 'ready', connected: true, canWrite: true, clientConfigured: true, selectionRequired: true,
        profile: { id: 'u1', email: 'chris@example.com', name: 'Chris' }, refreshedAt: '2026-07-13T18:00:00Z',
        calendars: [{ id: 'primary', summary: 'Main', primary: true, selected: true }, { id: 'work', summary: 'Work', primary: false, selected: false }],
      },
      onLater: () => undefined,
      onSave: async () => undefined,
    }));
    expect(html).toContain('Signed in as');
    expect(html).toContain('chris@example.com');
    expect(html).toContain('Main');
    expect(html).toContain('Work');
    expect(html).toContain('Use selected calendars');
  });
});
