import { afterEach, describe, expect, it } from 'vitest';

import { createSquirlServer } from './server.js';

describe('calendar OAuth API routing', () => {
  const servers: Array<ReturnType<typeof createSquirlServer>['server']> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  it('uses the API server for the Google callback and returns split-dev users to the UI', async () => {
    let startArgs: string[] = [];
    const runtime = {
      calendarAuthorizationUrl(callbackOrigin: string, returnOrigin: string) {
        startArgs = [callbackOrigin, returnOrigin];
        return 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state';
      },
      async completeCalendarAuthorization() { return 'http://127.0.0.1:5173'; },
    };
    const instance = createSquirlServer({ runtime: runtime as never });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const apiOrigin = `http://127.0.0.1:${address.port}`;

    const start = await fetch(`${apiOrigin}/api/calendar/oauth/start`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(start.status).toBe(200);
    expect(startArgs).toEqual([apiOrigin, 'http://127.0.0.1:5173']);

    const callback = await fetch(`${apiOrigin}/api/calendar/oauth/callback?code=code&state=test-state`, { redirect: 'manual' });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('http://127.0.0.1:5173');
  });
});
