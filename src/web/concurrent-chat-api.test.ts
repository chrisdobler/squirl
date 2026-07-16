import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSquirlServer } from './server.js';

describe('concurrent chat API', () => {
  const servers: Array<ReturnType<typeof createSquirlServer>['server']> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  it('acknowledges queued work without holding the chat request open', async () => {
    const submitChat = vi.fn(async () => ({
      turn: { id: 'turn-2', participantId: 'cc', input: 'follow up', enqueuedAt: new Date().toISOString() },
      started: false,
      queuePosition: 1,
      created: true,
    }));
    const runtime = { submitChat, getState: () => ({ storage: { available: true } }) } as unknown as ReturnType<typeof createSquirlServer>['runtime'];
    const instance = createSquirlServer({ runtime });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'follow up', recipientId: 'cc', requestId: 'request-1' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ turnId: 'turn-2', participantId: 'cc', started: false, queuePosition: 1, created: true });
    expect(submitChat).toHaveBeenCalledWith('follow up', 'cc', 'request-1', undefined);
  });

  it('keeps a background event subscription open and sends its initial state', async () => {
    const unsubscribe = vi.fn();
    const subscribeEvents = vi.fn((listener: (event: unknown) => void) => {
      listener({ type: 'work-state', work: { active: [], queued: [] } });
      return unsubscribe;
    });
    const runtime = { subscribeEvents } as unknown as ReturnType<typeof createSquirlServer>['runtime'];
    const instance = createSquirlServer({ runtime });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"work-state"');
    await reader.cancel();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
  });

  it('rejects stale activity actions with a conflict response', async () => {
    const performActivityAction = vi.fn(async () => { throw new Error('Action approve is no longer valid for this activity.'); });
    const runtime = { performActivityAction } as unknown as ReturnType<typeof createSquirlServer>['runtime'];
    const instance = createSquirlServer({ runtime });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/activities/activity-1/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Action approve is no longer valid for this activity.' });
    expect(performActivityAction).toHaveBeenCalledWith('activity-1', 'approve', undefined);
  });
});
