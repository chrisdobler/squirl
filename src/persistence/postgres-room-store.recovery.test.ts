import { EventEmitter } from 'node:events';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresRoomStore } from './postgres-room-store.js';

function result(rows: unknown[] = []): QueryResult<any> {
  return { command: '', rowCount: rows.length, oid: 0, fields: [], rows };
}

class FakeClient extends EventEmitter {
  readonly query = vi.fn<(...args: unknown[]) => Promise<QueryResult<any>>>();
  readonly release = vi.fn();
}

class FakePool extends EventEmitter {
  readonly clients: FakeClient[] = [];
  readonly query = vi.fn(async () => result([{ ok: 1 }]));
  readonly end = vi.fn(async () => undefined);

  async connect(): Promise<PoolClient> {
    const client = this.clients.shift();
    if (!client) throw new Error('No fake client available');
    this.emit('acquire', client);
    return client as unknown as PoolClient;
  }
}

describe('PostgresRoomStore connection recovery', () => {
  it('survives a checked-out client socket error and uses a fresh client next time', async () => {
    const timeout = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const rollbackFailure = new Error('Client has already been closed');
    const failed = new FakeClient();
    failed.query
      .mockResolvedValueOnce(result()) // BEGIN
      .mockImplementationOnce(async () => {
        failed.emit('error', timeout);
        throw timeout;
      })
      .mockRejectedValueOnce(rollbackFailure);

    const recovered = new FakeClient();
    recovered.query
      .mockResolvedValueOnce(result()) // BEGIN
      .mockResolvedValueOnce(result()) // existing request lookup
      .mockResolvedValueOnce(result([{
        id: '00000000-0000-4000-8000-000000000010',
        room_id: '00000000-0000-4000-8000-000000000001',
        request_id: 'request-2', participant_id: 'codex', input: 'retry', metadata: {},
        status: 'queued', attempt: 1, enqueued_at: new Date().toISOString(),
        started_at: null, finished_at: null, lease_expires_at: null, last_error: null,
        source_message_id: null, handoff_message_id: null,
      }]))
      .mockResolvedValueOnce(result()); // COMMIT

    const pool = new FakePool();
    pool.clients.push(failed, recovered);
    const store = new PostgresRoomStore('postgresql://unused', undefined, pool as unknown as Pool);

    await expect(store.enqueue({ requestId: 'request-1', participantId: 'codex', input: 'fail' })).rejects.toBe(timeout);
    expect(failed.release).toHaveBeenCalledWith(timeout);
    expect(failed.query).toHaveBeenLastCalledWith('ROLLBACK');

    await expect(store.enqueue({ requestId: 'request-2', participantId: 'codex', input: 'retry' }))
      .resolves.toMatchObject({ created: true, turn: { requestId: 'request-2' } });
    expect(recovered.release).toHaveBeenCalledOnce();
  });

  it('enables connection and TCP keepalive timeouts on real pools', async () => {
    const store = new PostgresRoomStore('postgresql://unused');
    expect(store.pool.options).toMatchObject({
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    await store.close();
  });
});
