import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSquirlServer } from './server.js';

describe('concurrent chat API', () => {
  const servers: Array<ReturnType<typeof createSquirlServer>['server']> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  it('acknowledges queued work without holding the chat request open', async () => {
    const submitChat = vi.fn(() => ({
      turn: { id: 'turn-2', participantId: 'cc', input: 'follow up', enqueuedAt: new Date().toISOString() },
      started: false,
      queuePosition: 1,
    }));
    const runtime = { submitChat } as unknown as ReturnType<typeof createSquirlServer>['runtime'];
    const instance = createSquirlServer({ runtime });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'follow up', recipientId: 'cc' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ turnId: 'turn-2', participantId: 'cc', started: false, queuePosition: 1 });
    expect(submitChat).toHaveBeenCalledWith('follow up', 'cc', undefined);
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
});
