import { describe, expect, it } from 'vitest';
import { GroupChatCoordinator } from './coordinator.js';
import type { AgentDescriptor, AgentEvent, AgentSession, AgentStatus } from './types.js';

/** A synchronous, scriptable AgentSession test double. */
class FakeSession implements AgentSession {
  status: AgentStatus = 'ready';
  sent: string[] = [];
  private listeners = new Set<(event: AgentEvent) => void>();

  constructor(readonly descriptor: AgentDescriptor, private readonly reply: (text: string) => string) {}

  start(): Promise<void> { return Promise.resolve(); }
  interrupt(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  emit(event: AgentEvent): void { for (const h of [...this.listeners]) h(event); }

  send(text: string): Promise<void> {
    this.sent.push(text);
    const id = this.descriptor.id;
    const reply = this.reply(text);
    this.emit({ type: 'message-start', participantId: id, messageId: `${id}-1` });
    this.emit({ type: 'token', participantId: id, messageId: `${id}-1`, token: reply });
    this.emit({ type: 'message-end', participantId: id, messageId: `${id}-1`, content: reply });
    this.emit({ type: 'turn-end', participantId: id });
    return Promise.resolve();
  }
}

interface Harness {
  coordinator: GroupChatCoordinator;
  built: Map<string, FakeSession>;
  localInputs: string[];
  events: AgentEvent[];
}

function makeHarness(opts: { autoHandoff?: boolean; maxHops?: number; replies?: Record<string, (text: string) => string> } = {}): Harness {
  const built = new Map<string, FakeSession>();
  const localInputs: string[] = [];
  const events: AgentEvent[] = [];
  const replies = opts.replies ?? {};

  const coordinator = new GroupChatCoordinator({
    config: { autoHandoff: opts.autoHandoff, maxHops: opts.maxHops },
    localTurn: async (input, emit) => {
      localInputs.push(input);
      emit({ type: 'message-start', participantId: 'squirl', messageId: 's-1' });
      emit({ type: 'token', participantId: 'squirl', messageId: 's-1', token: `local:${input}` });
      emit({ type: 'turn-end', participantId: 'squirl' });
    },
    createSession: (descriptor) => {
      const session = new FakeSession(descriptor, replies[descriptor.id] ?? (() => 'ok'));
      built.set(descriptor.id, session);
      return session;
    },
  });
  coordinator.onEvent((e) => events.push(e));
  return { coordinator, built, localInputs, events };
}

function makeFacilitatorHarness(intervention: string | null) {
  const built = new Map<string, FakeSession>();
  const events: AgentEvent[] = [];
  let assessments = 0;
  const coordinator = new GroupChatCoordinator({
    localTurn: async () => {},
    facilitateTurn: async () => { assessments++; return intervention; },
    createSession: (descriptor) => {
      const session = new FakeSession(descriptor, () => 'specialist result');
      built.set(descriptor.id, session);
      return session;
    },
  });
  coordinator.onEvent((event) => events.push(event));
  return { coordinator, built, events, assessments: () => assessments };
}

function descriptor(id: string, kind: AgentDescriptor['kind'] = 'claude-code'): AgentDescriptor {
  return { id, kind, label: id, transport: 'local', cwd: '/repo' };
}

describe('GroupChatCoordinator', () => {
  it('routes bare text to the local squirl participant', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.dispatch('hello there', new AbortController().signal);
    expect(h.localInputs).toEqual(['hello there']);
    expect(h.built.get('cc')!.sent).toEqual([]);
  });

  it('routes explicitly to the selected agent without changing the message text', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.dispatchTo('cc', '@codex implement the adapter', new AbortController().signal);
    expect(h.built.get('cc')!.sent).toEqual(['@codex implement the adapter']);
    expect(h.localInputs).toEqual([]);
    // The agent's tokens were forwarded to coordinator subscribers.
    expect(h.events.some((e) => e.type === 'token' && e.participantId === 'cc')).toBe(true);
  });

  it('snapshots the resolved model and configured effort on response start', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent({ ...descriptor('cc'), model: 'fable', effort: 'medium' });
    h.built.get('cc')!.emit({ type: 'session-status', participantId: 'cc', status: 'ready', model: 'claude-fable-5' });
    await h.coordinator.dispatchTo('cc', 'hello', new AbortController().signal);
    expect(h.events.find((event) => event.type === 'message-start')).toMatchObject({
      responseMeta: { model: 'claude-fable-5', effort: 'medium' },
    });
  });

  it('tracks the latest session, model, and context usage for read-only previews', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent({ ...descriptor('cc'), model: 'configured-model' });
    h.built.get('cc')!.descriptor.sessionId = 'session-1';
    h.built.get('cc')!.emit({ type: 'session-status', participantId: 'cc', status: 'ready', sessionId: 'session-1', model: 'resolved-model' });
    h.built.get('cc')!.emit({ type: 'usage', participantId: 'cc', usage: { inputTokens: 1234, contextWindow: 200_000 } });
    expect(h.coordinator.getContextTelemetry('cc')).toMatchObject({
      participantId: 'cc', sessionId: 'session-1', modelId: 'resolved-model', inputTokens: 1234, contextWindow: 200_000,
    });
    await h.coordinator.removeAgent('cc');
    expect(h.coordinator.getContextTelemetry('cc')).toBeUndefined();
  });

  it('does NOT hand off when autoHandoff is disabled', async () => {
    const h = makeHarness({ autoHandoff: false, replies: { cc: () => 'done, @codex please run tests' } });
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.addAgent(descriptor('codex', 'codex'));
    await h.coordinator.dispatchTo('cc', 'build it', new AbortController().signal);
    expect(h.built.get('cc')!.sent).toEqual(['build it']);
    expect(h.built.get('codex')!.sent).toEqual([]);
  });

  it('hands off exactly maxHops times when autoHandoff is enabled', async () => {
    const h = makeHarness({
      autoHandoff: true,
      maxHops: 1,
      replies: { cc: () => 'ok @codex run the tests', codex: () => 'tests pass, @cc ship it' },
    });
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.addAgent(descriptor('codex', 'codex'));
    await h.coordinator.dispatchTo('cc', 'build it', new AbortController().signal);
    // cc -> codex is one hop; codex -> cc would be a second hop and is blocked by maxHops=1.
    expect(h.built.get('cc')!.sent).toEqual(['build it']);
    expect(h.built.get('codex')!.sent).toEqual(['ok @codex run the tests']);
  });

  it('ignores self-mentions to avoid loops', async () => {
    const h = makeHarness({ autoHandoff: true, maxHops: 5, replies: { cc: () => 'let me continue @cc' } });
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.dispatchTo('cc', 'go', new AbortController().signal);
    expect(h.built.get('cc')!.sent).toEqual(['go']);
  });

  it('does nothing when the signal is already aborted', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent(descriptor('cc'));
    const controller = new AbortController();
    controller.abort();
    await h.coordinator.dispatchTo('cc', 'go', controller.signal);
    expect(h.built.get('cc')!.sent).toEqual([]);
    expect(h.localInputs).toEqual([]);
  });

  it('lists user, squirl, and added agents as participants', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent(descriptor('cc'));
    const ids = h.coordinator.listParticipants().map((p) => p.id);
    expect(ids).toEqual(['user', 'squirl', 'cc']);
    expect(h.coordinator.listParticipants().find((p) => p.id === 'cc')?.status).toBe('ready');
    expect(h.events).toContainEqual({ type: 'session-status', participantId: 'cc', status: 'ready' });
  });

  it('assigns unique colors in palette order and rejects an eleventh live agent', async () => {
    const h = makeHarness();
    for (let index = 0; index < 10; index++) await h.coordinator.addAgent(descriptor(`agent-${index}`));
    const agents = h.coordinator.listParticipants().filter((participant) => participant.kind !== 'user' && participant.kind !== 'local-llm');
    expect(agents.map((participant) => participant.color)).toEqual([
      'magenta', 'orange', 'blue', 'green', 'red', 'yellow', 'gray', 'teal', 'violet', 'brown',
    ]);
    expect(new Set(agents.map((participant) => participant.color)).size).toBe(10);
    await expect(h.coordinator.addAgent(descriptor('agent-10'))).rejects.toThrow('all 10 identity colors are in use');
    expect(h.built.has('agent-10')).toBe(false);
  });

  it('reuses the first released color without colliding with live agents', async () => {
    const h = makeHarness();
    await h.coordinator.addAgent(descriptor('first'));
    await h.coordinator.addAgent(descriptor('second'));
    await h.coordinator.addAgent(descriptor('third'));
    await h.coordinator.removeAgent('second');
    const replacement = await h.coordinator.addAgent(descriptor('replacement'));
    expect(replacement.color).toBe('orange');
    const colors = h.coordinator.listParticipants()
      .filter((participant) => participant.kind !== 'user' && participant.kind !== 'local-llm')
      .map((participant) => participant.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('restarts a session under a renamed identity', async () => {
    const h = makeHarness();
    const original = await h.coordinator.addAgent(descriptor('cc'));
    const participant = await h.coordinator.renameAgent('cc', 'claude-builder', 'claude-builder');
    expect(participant.id).toBe('claude-builder');
    expect(participant.color).toBe(original.color);
    expect(h.coordinator.hasAgent('cc')).toBe(false);
    expect(h.coordinator.hasAgent('claude-builder')).toBe(true);
    await h.coordinator.dispatchTo('claude-builder', 'build it', new AbortController().signal);
    expect(h.built.get('claude-builder')!.sent).toEqual(['build it']);
  });

  it('stays silent when the facilitator assessment returns no intervention', async () => {
    const h = makeFacilitatorHarness(null);
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.dispatchTo('cc', 'work', new AbortController().signal);
    expect(h.assessments()).toBe(1);
    expect(h.events.filter((event) => event.type === 'message-start' && event.participantId === 'squirl')).toHaveLength(0);
  });

  it('emits one non-recursive Squirl intervention after a specialist turn', async () => {
    const h = makeFacilitatorHarness('There is a missing decision. Should I prepare the handoff?');
    await h.coordinator.addAgent(descriptor('cc'));
    await h.coordinator.dispatchTo('cc', 'work', new AbortController().signal);
    expect(h.assessments()).toBe(1);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'message-end', participantId: 'squirl', content: 'There is a missing decision. Should I prepare the handoff?',
    }));
  });
});
