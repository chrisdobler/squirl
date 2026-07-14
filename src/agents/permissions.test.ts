import { describe, expect, it } from 'vitest';
import { SessionPermissionBroker } from './permissions.js';

describe('SessionPermissionBroker', () => {
  it('supports once, scoped session, deny, and idempotent stale responses', async () => {
    const published: any[] = [];
    const broker = new SessionPermissionBroker((request) => published.push(request));
    const once = broker.request({ title: 'Run?', toolName: 'Bash' });
    broker.respond(published[0].id, { decision: 'allow-once' });
    broker.respond(published[0].id, { decision: 'deny' });
    expect(await once).toBe('allow-once');

    const scoped = broker.request({ title: 'Run?', toolName: 'Bash', sessionScope: { key: 'cmd', label: 'Always allow this command' } });
    broker.respond(published[1].id, { decision: 'allow-session' });
    expect(await scoped).toBe('allow-session');

    const unscoped = broker.request({ title: 'Run?', toolName: 'Bash' });
    broker.respond(published[2].id, { decision: 'allow-session' });
    expect(await unscoped).toBe('allow-once');
  });

  it('fails all pending requests closed on reconnect or stop', async () => {
    const published: any[] = [];
    const broker = new SessionPermissionBroker((request) => published.push(request));
    const first = broker.request({ title: 'One', toolName: 'Edit' });
    const second = broker.request({ title: 'Two', toolName: 'Bash' });
    broker.denyAll();
    await expect(Promise.all([first, second])).resolves.toEqual(['deny', 'deny']);
    expect(broker.hasPending()).toBe(false);
  });
});
