import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/fake.js';
import type { AgentDescriptor } from '../types.js';
import { BaseAgentSession } from './base.js';

class TestSession extends BaseAgentSession {
  start = async () => undefined;
  send = async () => undefined;
  interrupt = async () => undefined;
  stop = async () => undefined;
  messageId(): string { return this.nextMessageId(); }
}

const descriptor: AgentDescriptor = { id: 'cc-squirl', kind: 'claude-code', label: 'Claude', transport: 'local', cwd: '/repo' };

describe('BaseAgentSession durable message ids', () => {
  it('does not reuse ids when an adapter is recreated after restart', () => {
    const first = new TestSession(descriptor, new FakeTransport()).messageId();
    const restarted = new TestSession(descriptor, new FakeTransport()).messageId();
    expect(first).toMatch(/^cc-squirl-[0-9a-f-]{36}$/);
    expect(restarted).toMatch(/^cc-squirl-[0-9a-f-]{36}$/);
    expect(restarted).not.toBe(first);
  });
});
