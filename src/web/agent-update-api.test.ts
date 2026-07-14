import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSquirlServer } from './server.js';

describe('agent update API', () => {
  const servers: Array<ReturnType<typeof createSquirlServer>['server']> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  it('forwards editable fields and returns the refreshed state', async () => {
    const state = { participants: [] };
    const updateAgent = vi.fn(async () => ({ ok: true as const, id: 'review-builder', label: 'review-builder' }));
    const runtime = { updateAgent, getState: () => state } as unknown as ReturnType<typeof createSquirlServer>['runtime'];
    const instance = createSquirlServer({ runtime, uiStatePath: join(mkdtempSync(join(tmpdir(), 'squirl-agent-api-')), 'state.json') });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'reviewer', name: 'Review Builder', model: null, effort: null, cwd: '/workspace', permissionMode: 'acceptEdits', sandbox: 'danger-full-access' }),
    });

    expect(response.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('reviewer', { name: 'Review Builder', model: null, effort: null, cwd: '/workspace', permissionMode: 'acceptEdits', sandbox: 'danger-full-access' });
    expect(await response.json()).toEqual({ state, agent: { ok: true, id: 'review-builder', label: 'review-builder' } });
  });
});
