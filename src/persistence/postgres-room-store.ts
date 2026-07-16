import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Message } from '../types.js';
import type { MemoryChunk } from '../search/memory-chunks.js';
import type { TurnPipelineTrace } from '../pipeline-trace.js';
import { runMigrations } from './migrations.js';
import type { DurableTurn, DurableTurnStatus, DurableWorkState, EnqueueTurnInput, HandoffInput, RoomStore, StoredMessage } from './types.js';

export const DEFAULT_ROOM_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

interface TurnRow extends QueryResultRow {
  id: string; room_id: string; request_id: string; participant_id: string; input: string;
  metadata: Record<string, unknown>; status: DurableTurnStatus; attempt: number;
  enqueued_at: Date | string; started_at: Date | string | null; finished_at: Date | string | null;
  lease_expires_at: Date | string | null; last_error: string | null;
  source_message_id: string | null; handoff_message_id: string | null;
}

interface MemoryChunkRow extends QueryResultRow {
  id: string; room_id: string; turn_id: string | null; source_message_id: string; context_message_id: string | null;
  ordinal: number; role: 'user' | 'assistant'; participant_id: string | null; content: string; context_text: string | null;
  content_hash: string; index_version: number; index_state: MemoryChunk['state']; attempts: number; created_at: Date | string;
}

function iso(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function turnFromRow(row: TurnRow): DurableTurn {
  return {
    id: row.id, roomId: row.room_id, requestId: row.request_id, participantId: row.participant_id,
    input: row.input, metadata: row.metadata ?? {}, status: row.status, attempt: row.attempt,
    enqueuedAt: iso(row.enqueued_at)!, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
    leaseExpiresAt: iso(row.lease_expires_at), lastError: row.last_error ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined, handoffMessageId: row.handoff_message_id ?? undefined,
  };
}

function memoryChunkFromRow(row: MemoryChunkRow): MemoryChunk {
  return {
    id: row.id, roomId: row.room_id, turnId: row.turn_id ?? undefined,
    sourceMessageId: row.source_message_id, contextMessageId: row.context_message_id ?? undefined,
    ordinal: row.ordinal, role: row.role, participantId: row.participant_id ?? undefined,
    content: row.content, contextText: row.context_text ?? undefined, contentHash: row.content_hash,
    indexVersion: row.index_version, state: row.index_state, attempts: row.attempts,
    createdAt: iso(row.created_at)!,
  };
}

function messageValues(message: Message): [string, string, string | null, string, string, string] {
  return [message.id, message.role, message.participantId ?? null, message.content, JSON.stringify(message), new Date().toISOString()];
}

export class PostgresRoomStore implements RoomStore {
  readonly roomId: string;
  readonly pool: Pool;
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly guardedClients = new WeakSet<PoolClient>();

  constructor(connectionString: string, roomId = DEFAULT_ROOM_ID, pool?: Pool) {
    this.roomId = roomId;
    this.pool = pool ?? new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    // pg-pool removes its idle error listener while a client is checked out.
    // Keep a permanent listener on every acquired client so a dead socket can
    // reject the active query without becoming an uncaught EventEmitter error.
    this.pool.on('acquire', (client) => {
      if (this.guardedClients.has(client)) return;
      this.guardedClients.add(client);
      client.on('error', () => undefined);
    });
    this.pool.on('error', (error) => {
      for (const listener of this.errorListeners) listener(error);
    });
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    let releaseError: Error | boolean | undefined;
    try {
      await client.query('BEGIN');
      await runMigrations(client);
      await client.query(`INSERT INTO squirl_users(id, external_subject, display_name)
        VALUES ($1, 'dev-user', 'Local user') ON CONFLICT (id) DO NOTHING`, [DEFAULT_USER_ID]);
      await client.query(`INSERT INTO squirl_rooms(id, name) VALUES ($1, 'Main room') ON CONFLICT (id) DO NOTHING`, [this.roomId]);
      await client.query(`INSERT INTO squirl_room_members(room_id, user_id, role)
        VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [this.roomId, DEFAULT_USER_ID]);
      await client.query('COMMIT');
    } catch (error) {
      releaseError = error instanceof Error ? error : true;
      // The original failure may mean the connection is already dead. Preserve
      // it instead of replacing it with a secondary ROLLBACK failure.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(releaseError); }
  }

  async close(): Promise<void> { await this.pool.end(); }
  async health(): Promise<boolean> {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }

  async loadMessages(limit = 50_000): Promise<StoredMessage[]> {
    const result = await this.pool.query(`SELECT sequence, timeline_order, created_at, turn_id, payload
      FROM squirl_messages WHERE room_id=$1 ORDER BY timeline_order DESC, sequence DESC LIMIT $2`, [this.roomId, limit]);
    return result.rows.reverse().map((row) => ({
      sequence: Number(row.sequence), timelineOrder: Number(row.timeline_order),
      timestamp: iso(row.created_at)!, turnId: row.turn_id ?? undefined, message: row.payload as Message,
    }));
  }

  async insertMessage(message: Message, turnId?: string, timestamp = new Date().toISOString()): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO squirl_messages(id, room_id, turn_id, role, participant_id, content, payload, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [message.id, this.roomId, turnId ?? null, message.role, message.participantId ?? null, message.content, JSON.stringify(message), timestamp]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new Error(`Message id collision: ${message.id}`);
      throw error;
    }
  }

  async updateMessage(message: Message, turnId?: string): Promise<void> {
    const updated = await this.pool.query(`UPDATE squirl_messages SET
        content=$5, payload=$6::jsonb, turn_id=COALESCE(turn_id,$7)
      WHERE id=$1 AND room_id=$2 AND role=$3
        AND participant_id IS NOT DISTINCT FROM $4::text
        AND (turn_id IS NULL OR $7::uuid IS NULL OR turn_id=$7::uuid)
      RETURNING id`,
    [message.id, this.roomId, message.role, message.participantId ?? null, message.content, JSON.stringify(message), turnId ?? null]);
    if ((updated.rowCount ?? 0) > 0) return;
    const exists = await this.pool.query('SELECT 1 FROM squirl_messages WHERE id=$1 AND room_id=$2', [message.id, this.roomId]);
    if (exists.rows[0]) throw new Error(`Message identity mismatch: ${message.id}`);
    throw new Error(`Cannot update missing message: ${message.id}`);
  }

  async auditMessageOrder(): Promise<{ ambiguousLegacyIds: string[] }> {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM squirl_messages
      WHERE room_id=$1 AND id ~ '-[0-9]+$'
        AND id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND timeline_order=sequence
      ORDER BY timeline_order,sequence`, [this.roomId]);
    return { ambiguousLegacyIds: result.rows.map((row) => row.id) };
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | boolean | undefined;
    try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
    catch (error) {
      releaseError = error instanceof Error ? error : true;
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(releaseError); }
  }

  async enqueue(input: EnqueueTurnInput): Promise<{ turn: DurableTurn; created: boolean }> {
    return this.transaction(async (client) => {
      const existing = await client.query<TurnRow>('SELECT * FROM squirl_turns WHERE room_id=$1 AND request_id=$2', [this.roomId, input.requestId]);
      if (existing.rows[0]) return { turn: turnFromRow(existing.rows[0]), created: false };
      const turnId = randomUUID();
      if (input.message) {
        await client.query(`INSERT INTO squirl_messages(id,room_id,turn_id,role,participant_id,content,payload,created_at)
          VALUES ($1,$2,NULL,$3,$4,$5,$6::jsonb,$7)`, [input.message.id, this.roomId, input.message.role, input.message.participantId ?? null, input.message.content, JSON.stringify(input.message), input.timestamp ?? new Date().toISOString()]);
      }
      const result = await client.query<TurnRow>(`INSERT INTO squirl_turns
        (id,room_id,request_id,participant_id,input,metadata,status,source_message_id,enqueued_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,'queued',$7,$8) RETURNING *`,
      [turnId, this.roomId, input.requestId, input.participantId, input.input, JSON.stringify(input.metadata ?? {}), input.message?.id ?? null, input.timestamp ?? new Date().toISOString()]);
      if (input.message) await client.query('UPDATE squirl_messages SET turn_id=$1 WHERE id=$2', [turnId, input.message.id]);
      return { turn: turnFromRow(result.rows[0]!), created: true };
    });
  }

  async commitHandoff(input: HandoffInput): Promise<{ turn: DurableTurn; created: boolean }> {
    return this.transaction(async (client) => {
      const existing = await client.query<TurnRow>('SELECT * FROM squirl_turns WHERE room_id=$1 AND request_id=$2', [this.roomId, input.requestId]);
      if (existing.rows[0]) return { turn: turnFromRow(existing.rows[0]), created: false };
      const turnId = randomUUID();
      await client.query(`INSERT INTO squirl_messages(id,room_id,turn_id,role,participant_id,content,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [input.handoffMessage.id, this.roomId, input.parentTurnId ?? null, input.handoffMessage.role, input.handoffMessage.participantId ?? null, input.handoffMessage.content, JSON.stringify(input.handoffMessage)]);
      const result = await client.query<TurnRow>(`INSERT INTO squirl_turns
        (id,room_id,request_id,participant_id,input,metadata,status,handoff_message_id)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,'queued',$7) RETURNING *`,
      [turnId, this.roomId, input.requestId, input.participantId, input.input, JSON.stringify({ ...input.metadata, ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}) }), input.handoffMessage.id]);
      return { turn: turnFromRow(result.rows[0]!), created: true };
    });
  }

  async claim(workerId: string, leaseMs: number): Promise<DurableTurn | null> {
    return this.transaction(async (client) => {
      const result = await client.query<TurnRow>(`WITH candidate AS (
        SELECT t.id FROM squirl_turns t
        WHERE t.room_id=$1 AND t.status='queued'
          AND NOT EXISTS (SELECT 1 FROM squirl_turns active WHERE active.room_id=t.room_id AND active.participant_id=t.participant_id AND active.status='running')
        ORDER BY t.enqueued_at, t.id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE squirl_turns t SET status='running', started_at=now(), finished_at=NULL,
        lease_owner=$2, lease_expires_at=now()+($3::text || ' milliseconds')::interval, last_error=NULL
      FROM candidate WHERE t.id=candidate.id RETURNING t.*`, [this.roomId, workerId, leaseMs]);
      return result.rows[0] ? turnFromRow(result.rows[0]) : null;
    });
  }

  async renew(turnId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE squirl_turns SET lease_expires_at=now()+($3::text || ' milliseconds')::interval
      WHERE id=$1 AND lease_owner=$2 AND status='running'`, [turnId, workerId, leaseMs]);
    return (result.rowCount ?? 0) > 0;
  }

  async finish(turnId: string, workerId: string, status: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<void> {
    await this.pool.query(`UPDATE squirl_turns SET status=$3, finished_at=now(), lease_owner=NULL, lease_expires_at=NULL, last_error=$4
      WHERE id=$1 AND lease_owner=$2 AND status='running'`, [turnId, workerId, status, error ?? null]);
  }

  async interruptExpired(): Promise<number> {
    const result = await this.pool.query(`UPDATE squirl_turns SET status='interrupted', finished_at=now(), lease_owner=NULL,
      lease_expires_at=NULL, last_error=COALESCE(last_error,'The server restarted while this turn was active.')
      WHERE room_id=$1 AND status='running' AND lease_expires_at < now()`, [this.roomId]);
    return result.rowCount ?? 0;
  }

  async retry(turnId: string): Promise<DurableTurn | null> {
    const result = await this.pool.query<TurnRow>(`UPDATE squirl_turns SET status='queued', attempt=attempt+1,
      enqueued_at=now(), started_at=NULL, finished_at=NULL, lease_owner=NULL, lease_expires_at=NULL, last_error=NULL
      WHERE id=$1 AND room_id=$2 AND status IN ('interrupted','failed') RETURNING *`, [turnId, this.roomId]);
    return result.rows[0] ? turnFromRow(result.rows[0]) : null;
  }

  async cancel(turnId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE squirl_turns SET status='cancelled', finished_at=now(), lease_owner=NULL, lease_expires_at=NULL
      WHERE id=$1 AND room_id=$2 AND status IN ('queued','interrupted','failed')`, [turnId, this.roomId]);
    return (result.rowCount ?? 0) > 0;
  }

  async workState(): Promise<DurableWorkState> {
    const result = await this.pool.query<TurnRow>(`SELECT * FROM squirl_turns WHERE room_id=$1
      AND status IN ('queued','running','interrupted','failed') ORDER BY enqueued_at,id`, [this.roomId]);
    const turns = result.rows.map(turnFromRow);
    return {
      active: turns.filter((turn) => turn.status === 'running'), queued: turns.filter((turn) => turn.status === 'queued'),
      interrupted: turns.filter((turn) => turn.status === 'interrupted'), failed: turns.filter((turn) => turn.status === 'failed'),
    };
  }

  async latestHandoff(): Promise<DurableTurn | null> {
    const result = await this.pool.query<TurnRow>(`SELECT * FROM squirl_turns WHERE room_id=$1
      AND handoff_message_id IS NOT NULL ORDER BY enqueued_at DESC,id DESC LIMIT 1`, [this.roomId]);
    return result.rows[0] ? turnFromRow(result.rows[0]) : null;
  }

  async savePipelineTrace(trace: TurnPipelineTrace, retain: number): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`INSERT INTO squirl_pipeline_traces
        (room_id,turn_id,assistant_message_id,trace,started_at,updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,now())
        ON CONFLICT (room_id,turn_id) DO UPDATE SET
          assistant_message_id=EXCLUDED.assistant_message_id,
          trace=EXCLUDED.trace,
          started_at=EXCLUDED.started_at,
          updated_at=now()`, [this.roomId, trace.turnId, trace.assistantMessageId ?? null, JSON.stringify(trace), trace.startedAt]);
      await client.query(`DELETE FROM squirl_pipeline_traces candidate
        WHERE candidate.room_id=$1 AND candidate.turn_id IN (
          SELECT turn_id FROM squirl_pipeline_traces
          WHERE room_id=$1
          ORDER BY started_at DESC, updated_at DESC, turn_id DESC
          OFFSET $2
        )`, [this.roomId, Math.max(0, retain)]);
    });
  }

  async loadRecentPipelineTraces(limit: number): Promise<TurnPipelineTrace[]> {
    const result = await this.pool.query<{ trace: TurnPipelineTrace }>(`SELECT trace FROM squirl_pipeline_traces
      WHERE room_id=$1 ORDER BY started_at DESC,updated_at DESC,turn_id DESC LIMIT $2`, [this.roomId, Math.max(0, limit)]);
    return result.rows.map((row) => row.trace);
  }

  async rewindAfter(messageId: string | null): Promise<{ found: boolean; removed: Message[]; memoryChunkIds?: string[] }> {
    return this.transaction(async (client) => {
      let timelineOrder = -1;
      let sequence = 0;
      if (messageId) {
        const target = await client.query<{ sequence: string; timeline_order: string }>('SELECT sequence,timeline_order FROM squirl_messages WHERE room_id=$1 AND id=$2', [this.roomId, messageId]);
        if (!target.rows[0]) return { found: false, removed: [] };
        sequence = Number(target.rows[0].sequence);
        timelineOrder = Number(target.rows[0].timeline_order);
      }
      const afterTarget = `(timeline_order>$2::numeric OR (timeline_order=$2::numeric AND sequence>$3))`;
      const removed = await client.query<{ payload: Message }>(`SELECT payload FROM squirl_messages WHERE room_id=$1 AND ${afterTarget} ORDER BY timeline_order,sequence`, [this.roomId, timelineOrder, sequence]);
      const chunkIds = await client.query<{ id: string }>(`SELECT id FROM squirl_memory_chunks WHERE room_id=$1 AND source_message_id IN
        (SELECT id FROM squirl_messages WHERE room_id=$1 AND ${afterTarget})`, [this.roomId, timelineOrder, sequence]);
      await client.query(`UPDATE squirl_turns SET status='cancelled', finished_at=now(), lease_owner=NULL, lease_expires_at=NULL
        WHERE room_id=$1 AND status IN ('queued','interrupted','failed') AND (
          source_message_id IN (SELECT id FROM squirl_messages WHERE room_id=$1 AND ${afterTarget})
          OR handoff_message_id IN (SELECT id FROM squirl_messages WHERE room_id=$1 AND ${afterTarget}))`, [this.roomId, timelineOrder, sequence]);
      await client.query(`DELETE FROM squirl_messages WHERE room_id=$1 AND ${afterTarget}`, [this.roomId, timelineOrder, sequence]);
      return { found: true, removed: removed.rows.map((row) => row.payload), memoryChunkIds: chunkIds.rows.map((row) => row.id) };
    });
  }

  async replaceMemoryChunks(sourceMessageId: string, chunks: MemoryChunk[]): Promise<void> {
    await this.transaction(async (client) => {
      const retained = chunks.map((chunk) => chunk.id);
      if (retained.length > 0) {
        await client.query('DELETE FROM squirl_memory_chunks WHERE room_id=$1 AND source_message_id=$2 AND NOT (id = ANY($3::text[]))', [this.roomId, sourceMessageId, retained]);
      } else {
        await client.query('DELETE FROM squirl_memory_chunks WHERE room_id=$1 AND source_message_id=$2', [this.roomId, sourceMessageId]);
      }
      for (const chunk of chunks) {
        await client.query(`INSERT INTO squirl_memory_chunks
          (id,room_id,turn_id,source_message_id,context_message_id,ordinal,role,participant_id,content,context_text,content_hash,index_version,index_state,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)
          ON CONFLICT (id) DO UPDATE SET
            turn_id=EXCLUDED.turn_id, context_message_id=EXCLUDED.context_message_id, role=EXCLUDED.role,
            participant_id=EXCLUDED.participant_id, content=EXCLUDED.content, context_text=EXCLUDED.context_text,
            content_hash=EXCLUDED.content_hash,
            index_state=CASE WHEN squirl_memory_chunks.content_hash=EXCLUDED.content_hash THEN squirl_memory_chunks.index_state ELSE 'pending' END,
            attempts=CASE WHEN squirl_memory_chunks.content_hash=EXCLUDED.content_hash THEN squirl_memory_chunks.attempts ELSE 0 END,
            last_error=NULL, next_attempt_at=now(), lease_expires_at=NULL`,
        [chunk.id, this.roomId, chunk.turnId ?? null, sourceMessageId, chunk.contextMessageId ?? null, chunk.ordinal, chunk.role,
          chunk.participantId ?? null, chunk.content, chunk.contextText ?? null, chunk.contentHash, chunk.indexVersion, chunk.createdAt]);
      }
    });
  }

  async claimMemoryChunks(limit: number): Promise<MemoryChunk[]> {
    return this.transaction(async (client) => {
      const result = await client.query<MemoryChunkRow>(`WITH candidates AS (
        SELECT id FROM squirl_memory_chunks WHERE room_id=$1
          AND (index_state IN ('pending','failed') OR (index_state='indexing' AND lease_expires_at < now()))
          AND next_attempt_at <= now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE squirl_memory_chunks c SET index_state='indexing', attempts=c.attempts+1,
        lease_expires_at=now()+interval '2 minutes', last_error=NULL
      FROM candidates WHERE c.id=candidates.id RETURNING c.*`, [this.roomId, limit]);
      return result.rows.map(memoryChunkFromRow);
    });
  }

  async markMemoryChunksIndexed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE squirl_memory_chunks SET index_state='indexed', indexed_at=now(), lease_expires_at=NULL,
      last_error=NULL WHERE room_id=$1 AND id=ANY($2::text[])`, [this.roomId, ids]);
  }

  async markMemoryChunksFailed(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE squirl_memory_chunks SET index_state='failed', lease_expires_at=NULL, last_error=$3,
      next_attempt_at=now()+LEAST(interval '5 minutes', (interval '5 seconds' * power(2, LEAST(attempts,6))))
      WHERE room_id=$1 AND id=ANY($2::text[])`, [this.roomId, ids, error.slice(0, 1000)]);
  }

  async hydrateMemoryChunks(ids: string[]): Promise<MemoryChunk[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query<MemoryChunkRow>('SELECT * FROM squirl_memory_chunks WHERE room_id=$1 AND id=ANY($2::text[])', [this.roomId, ids]);
    const byId = new Map(result.rows.map((row) => [row.id, memoryChunkFromRow(row)]));
    return ids.map((id) => byId.get(id)).filter((chunk): chunk is MemoryChunk => Boolean(chunk));
  }

  async memoryChunkIdsForMessages(messageIds: string[]): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const result = await this.pool.query<{ id: string }>('SELECT id FROM squirl_memory_chunks WHERE room_id=$1 AND source_message_id=ANY($2::text[])', [this.roomId, messageIds]);
    return result.rows.map((row) => row.id);
  }
}
