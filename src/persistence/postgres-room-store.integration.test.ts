import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresRoomStore } from './postgres-room-store.js';
import { importAndArchiveJsonl } from './jsonl-import.js';
import { chunksForMessage } from '../search/memory-chunks.js';
import { createTurnPipelineTrace, finishTurnPipelineTrace, updateTurnPipelineTrace, type TurnPipelineTrace } from '../pipeline-trace.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('PostgresRoomStore integration', () => {
  const store = new PostgresRoomStore(databaseUrl!);

  beforeAll(async () => {
    const result = await store.pool.query<{ name: string }>('SELECT current_database() AS name');
    if (!result.rows[0]?.name.endsWith('_test')) {
      throw new Error(`Refusing to run destructive integration tests against non-test database ${result.rows[0]?.name ?? '(unknown)'}`);
    }
  });

  beforeEach(async () => {
    await store.initialize();
    await store.pool.query('DELETE FROM squirl_pipeline_traces');
    await store.pool.query('DELETE FROM squirl_messages');
    await store.pool.query('DELETE FROM squirl_turns');
  });
  afterAll(async () => { await store.close(); });

  it('runs migrations repeatedly and deduplicates accepted requests', async () => {
    const concurrent = new PostgresRoomStore(databaseUrl!);
    await Promise.all([store.initialize(), concurrent.initialize()]);
    await concurrent.close();
    const message = { id: randomUUID(), role: 'user' as const, content: 'investigate', participantId: 'codex-k8s' };
    const first = await store.enqueue({ requestId: 'request-1', participantId: 'codex-k8s', input: 'investigate', message });
    const second = await store.enqueue({ requestId: 'request-1', participantId: 'codex-k8s', input: 'duplicate', message: { ...message, id: randomUUID() } });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, turn: { id: first.turn.id, input: 'investigate' } });
    expect((await store.loadMessages()).map((entry) => entry.message.id)).toEqual([message.id]);
  });

  it('persists and updates activity transcript records in place', async () => {
    const id = `activity-${randomUUID()}`;
    const base = {
      id, role: 'activity' as const, content: 'Researching', participantId: 'cc-squirl-fable',
      activity: { version: 1 as const, kind: 'research' as const, state: 'running' as const, title: 'Researching', participantId: 'cc-squirl-fable', updatedAt: '2026-07-14T00:00:00Z', actions: [] },
    };
    await store.insertMessage(base);
    const before = (await store.loadMessages()).find((entry) => entry.message.id === id)!;
    await store.updateMessage({ ...base, content: 'Complete', activity: { ...base.activity, state: 'succeeded', updatedAt: '2026-07-14T00:01:00Z', collapsed: true } });
    const stored = (await store.loadMessages()).filter((entry) => entry.message.id === id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.timelineOrder).toBe(before.timelineOrder);
    expect(stored[0]?.sequence).toBe(before.sequence);
    expect(stored[0]?.message).toMatchObject({ role: 'activity', content: 'Complete', activity: { state: 'succeeded', collapsed: true } });
  });

  it('rejects id collisions and identity-changing updates', async () => {
    const message = { id: randomUUID(), role: 'assistant' as const, content: 'first', participantId: 'claude' };
    await store.insertMessage(message);
    await expect(store.insertMessage({ ...message, content: 'replacement' })).rejects.toThrow(`Message id collision: ${message.id}`);
    await expect(store.updateMessage({ ...message, participantId: 'codex', content: 'wrong owner' })).rejects.toThrow(`Message identity mismatch: ${message.id}`);
    await expect(store.updateMessage({ id: message.id, role: 'user', participantId: 'claude', content: 'wrong role' })).rejects.toThrow(`Message identity mismatch: ${message.id}`);
    expect((await store.loadMessages()).find((entry) => entry.message.id === message.id)?.message.content).toBe('first');

    const firstTurn = await store.enqueue({ requestId: 'identity-turn-1', participantId: 'claude', input: 'one' });
    const secondTurn = await store.enqueue({ requestId: 'identity-turn-2', participantId: 'claude', input: 'two' });
    const turnMessage = { id: randomUUID(), role: 'assistant' as const, participantId: 'claude', content: 'turn one' };
    await store.insertMessage(turnMessage, firstTurn.turn.id);
    await expect(store.updateMessage({ ...turnMessage, content: 'wrong turn' }, secondTurn.turn.id)).rejects.toThrow(`Message identity mismatch: ${turnMessage.id}`);
  });

  it('loads and rewinds by immutable timeline order instead of storage sequence', async () => {
    const launch = { id: randomUUID(), role: 'assistant' as const, content: 'launch', participantId: 'claude' };
    const filler = { id: randomUUID(), role: 'assistant' as const, content: 'unrelated' };
    const workflow = { id: randomUUID(), role: 'tool' as const, toolCallId: 'workflow', toolName: 'claude:Workflow', content: 'started', participantId: 'claude' };
    const card = { id: randomUUID(), role: 'activity' as const, content: 'running', participantId: 'claude', activity: { version: 1 as const, kind: 'research' as const, state: 'running' as const, title: 'running', participantId: 'claude', updatedAt: new Date().toISOString(), actions: [] } };
    for (const message of [launch, filler, workflow, card]) await store.insertMessage(message);
    const workflowRow = (await store.loadMessages()).find((entry) => entry.message.id === workflow.id)!;
    await store.pool.query('UPDATE squirl_messages SET timeline_order=$2 WHERE id=$1', [launch.id, workflowRow.timelineOrder - 0.5]);

    expect((await store.loadMessages()).map((entry) => entry.message.id)).toEqual([filler.id, launch.id, workflow.id, card.id]);
    expect(await store.rewindAfter(launch.id)).toMatchObject({ found: true, removed: [workflow, card] });
    expect((await store.loadMessages()).map((entry) => entry.message.id)).toEqual([filler.id, launch.id]);
  });

  it('claims FIFO per participant while allowing different participants to run', async () => {
    await store.enqueue({ requestId: 'a1', participantId: 'a', input: 'first' });
    await store.enqueue({ requestId: 'a2', participantId: 'a', input: 'second' });
    await store.enqueue({ requestId: 'b1', participantId: 'b', input: 'other' });
    const first = await store.claim('worker-1', 30_000);
    const concurrent = await store.claim('worker-2', 30_000);
    const blocked = await store.claim('worker-3', 30_000);
    expect(first).toMatchObject({ participantId: 'a', input: 'first' });
    expect(concurrent).toMatchObject({ participantId: 'b', input: 'other' });
    expect(blocked).toBeNull();
    await store.finish(first!.id, 'worker-1', 'succeeded');
    expect(await store.claim('worker-3', 30_000)).toMatchObject({ participantId: 'a', input: 'second' });
  });

  it('interrupts expired active work and requires an explicit retry', async () => {
    const queued = await store.enqueue({ requestId: 'restart', participantId: 'codex', input: 'work' });
    await store.claim('old-worker', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.interruptExpired()).toBe(1);
    expect((await store.workState()).interrupted).toEqual([expect.objectContaining({ id: queued.turn.id, attempt: 1 })]);
    expect(await store.claim('new-worker', 30_000)).toBeNull();
    expect(await store.retry(queued.turn.id)).toMatchObject({ status: 'queued', attempt: 2 });
    expect(await store.claim('new-worker', 30_000)).toMatchObject({ id: queued.turn.id, attempt: 2 });
  });

  it('cancels queued work and rewind cancels turns whose source message is removed', async () => {
    const cancelled = await store.enqueue({ requestId: 'cancel-me', participantId: 'codex', input: 'cancel' });
    expect(await store.cancel(cancelled.turn.id)).toBe(true);
    expect(await store.claim('worker', 30_000)).toBeNull();

    const anchor = { id: randomUUID(), role: 'assistant' as const, content: 'keep this' };
    await store.insertMessage(anchor);
    const source = { id: randomUUID(), role: 'user' as const, content: 'rewind this' };
    const queued = await store.enqueue({ requestId: 'rewind-me', participantId: 'codex', input: source.content, message: source });
    const rewind = await store.rewindAfter(anchor.id);
    expect(rewind).toMatchObject({ found: true, removed: [source] });
    expect(await store.claim('worker', 30_000)).toBeNull();
    const row = await store.pool.query('SELECT status FROM squirl_turns WHERE id=$1', [queued.turn.id]);
    expect(row.rows[0]?.status).toBe('cancelled');
  });

  it('commits a visible handoff and its target turn atomically', async () => {
    const parent = await store.enqueue({ requestId: 'parent', participantId: 'squirl', input: 'ask codex' });
    const handoff = { id: randomUUID(), role: 'assistant' as const, content: 'Handoff to @codex-k8s' };
    const child = await store.commitHandoff({ parentTurnId: parent.turn.id, requestId: 'child', participantId: 'codex-k8s', input: handoff.content, handoffMessage: handoff });
    expect(child).toMatchObject({ created: true, turn: { participantId: 'codex-k8s', handoffMessageId: handoff.id } });
    expect((await store.loadMessages()).at(-1)?.message).toEqual(handoff);
    expect(await store.latestHandoff()).toMatchObject({ id: child.turn.id, participantId: 'codex-k8s' });
  });

  it('imports legacy JSONL once and archives it only after commit', async () => {
    const historyDir = mkdtempSync(join(tmpdir(), 'squirl-history-'));
    const source = join(historyDir, 'current.jsonl');
    const message = { id: 'codex-k8s-legacy-6', role: 'user' as const, content: 'legacy message' };
    writeFileSync(source, `${JSON.stringify({ timestamp: '2026-07-01T00:00:00.000Z', message })}\n`);
    const result = await importAndArchiveJsonl(store, historyDir);
    expect(result).toMatchObject({ imported: 1 });
    expect(readFileSync(join(result.archivePath!, 'current.jsonl'), 'utf8')).toContain(message.id);
    expect((await store.loadMessages()).at(-1)?.message).toEqual(message);
    expect(await importAndArchiveJsonl(store, historyDir)).toEqual({ imported: 0 });
  });

  it('durably claims, hydrates, and cascade-removes semantic chunks', async () => {
    const user = { id: randomUUID(), role: 'user' as const, content: 'What voice stack should Squirl use?' };
    const assistant = { id: randomUUID(), role: 'assistant' as const, participantId: 'cc-squirl-fable', content: 'Use LiveKit Agents or Pipecat.' };
    await store.insertMessage(user);
    await store.insertMessage(assistant);
    const chunks = chunksForMessage({ roomId: store.roomId, message: assistant, timestamp: '2026-07-14T00:00:00Z', contextMessage: user });
    await store.replaceMemoryChunks(assistant.id, chunks);
    expect(await store.claimMemoryChunks(10)).toEqual([expect.objectContaining({ id: chunks[0]!.id, state: 'indexing', attempts: 1 })]);
    await store.markMemoryChunksIndexed([chunks[0]!.id]);
    expect(await store.hydrateMemoryChunks([chunks[0]!.id])).toEqual([expect.objectContaining({ content: assistant.content, state: 'indexed' })]);
    const rewind = await store.rewindAfter(user.id);
    expect(rewind.memoryChunkIds).toEqual([chunks[0]!.id]);
    expect(await store.hydrateMemoryChunks([chunks[0]!.id])).toEqual([]);
  });

  it('upserts, orders, prunes, and rewind-removes durable pipeline traces', async () => {
    for (let index = 0; index < 11; index++) {
      const turn = await store.enqueue({ requestId: `trace-${index}`, participantId: 'squirl', input: `request ${index}` });
      const assistantMessageId = randomUUID();
      await store.insertMessage({ id: assistantMessageId, role: 'assistant', content: `answer ${index}` }, turn.turn.id);
      let trace: TurnPipelineTrace = {
        ...createTurnPipelineTrace(turn.turn.id, `request ${index}`),
        assistantMessageId,
        startedAt: new Date(Date.UTC(2026, 6, 16, 0, index)).toISOString(),
      };
      trace = updateTurnPipelineTrace(trace, { id: 'answer', state: 'succeeded', output: { index } });
      await store.savePipelineTrace(finishTurnPipelineTrace(trace, 'succeeded'), 10);
    }
    const retained = await store.loadRecentPipelineTraces(10);
    expect(retained).toHaveLength(10);
    expect(retained[0]).toMatchObject({ request: 'request 10', state: 'succeeded' });
    expect(retained.at(-1)).toMatchObject({ request: 'request 1' });

    const target = (await store.loadMessages()).find((entry) => entry.message.content === 'answer 9')!;
    await store.rewindAfter(target.message.id);
    expect((await store.loadRecentPipelineTraces(10)).some((trace) => trace.request === 'request 10')).toBe(false);
  });
});
