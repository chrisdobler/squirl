import type { PoolClient } from 'pg';

export const SCHEMA_VERSION = 7;

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS squirl_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squirl_users (
  id uuid PRIMARY KEY,
  external_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squirl_rooms (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squirl_room_members (
  room_id uuid NOT NULL REFERENCES squirl_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES squirl_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS squirl_turns (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES squirl_rooms(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  participant_id text NOT NULL,
  input text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('queued','running','interrupted','succeeded','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  source_message_id uuid,
  handoff_message_id uuid,
  UNIQUE (room_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS squirl_turns_one_running_participant
  ON squirl_turns (room_id, participant_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS squirl_turns_claim_order
  ON squirl_turns (room_id, status, enqueued_at, id);

CREATE TABLE IF NOT EXISTS squirl_messages (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  room_id uuid NOT NULL REFERENCES squirl_rooms(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES squirl_turns(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  participant_id text,
  content text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS squirl_messages_room_sequence ON squirl_messages (room_id, sequence);

ALTER TABLE squirl_turns
  ADD CONSTRAINT squirl_turns_source_message_fk
  FOREIGN KEY (source_message_id) REFERENCES squirl_messages(id) ON DELETE SET NULL;
ALTER TABLE squirl_turns
  ADD CONSTRAINT squirl_turns_handoff_message_fk
  FOREIGN KEY (handoff_message_id) REFERENCES squirl_messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS squirl_imports (
  source text NOT NULL,
  digest text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL,
  PRIMARY KEY (source, digest)
);
`;

export async function runMigrations(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [7_617_537_641]);
  await client.query(`CREATE TABLE IF NOT EXISTS squirl_schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = await client.query<{ version: number }>('SELECT version FROM squirl_schema_migrations');
  const versions = new Set(applied.rows.map((row) => row.version));
  if (!versions.has(1)) {
    await client.query(MIGRATION_001);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING');
  }
  if (!versions.has(2)) {
    await client.query(`
      ALTER TABLE squirl_turns DROP CONSTRAINT IF EXISTS squirl_turns_source_message_fk;
      ALTER TABLE squirl_turns DROP CONSTRAINT IF EXISTS squirl_turns_handoff_message_fk;
      ALTER TABLE squirl_turns ALTER COLUMN source_message_id TYPE text USING source_message_id::text;
      ALTER TABLE squirl_turns ALTER COLUMN handoff_message_id TYPE text USING handoff_message_id::text;
      ALTER TABLE squirl_messages ALTER COLUMN id TYPE text USING id::text;
      ALTER TABLE squirl_turns ADD CONSTRAINT squirl_turns_source_message_fk
        FOREIGN KEY (source_message_id) REFERENCES squirl_messages(id) ON DELETE SET NULL;
      ALTER TABLE squirl_turns ADD CONSTRAINT squirl_turns_handoff_message_fk
        FOREIGN KEY (handoff_message_id) REFERENCES squirl_messages(id) ON DELETE SET NULL;
    `);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING');
  }
  if (!versions.has(3)) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS squirl_memory_chunks (
        id text PRIMARY KEY,
        room_id uuid NOT NULL REFERENCES squirl_rooms(id) ON DELETE CASCADE,
        turn_id uuid REFERENCES squirl_turns(id) ON DELETE SET NULL,
        source_message_id text NOT NULL REFERENCES squirl_messages(id) ON DELETE CASCADE,
        context_message_id text REFERENCES squirl_messages(id) ON DELETE SET NULL,
        ordinal integer NOT NULL CHECK (ordinal >= 0),
        role text NOT NULL CHECK (role IN ('user','assistant')),
        participant_id text,
        content text NOT NULL,
        context_text text,
        content_hash text NOT NULL,
        index_version integer NOT NULL,
        index_state text NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending','indexing','indexed','failed')),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        lease_expires_at timestamptz,
        indexed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (room_id, source_message_id, index_version, ordinal)
      );
      CREATE INDEX IF NOT EXISTS squirl_memory_chunks_claim
        ON squirl_memory_chunks (room_id, index_state, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS squirl_memory_chunks_source
        ON squirl_memory_chunks (room_id, source_message_id);
      DELETE FROM squirl_messages WHERE id IN (
        'f234c3fb-2ecb-45ac-9756-aafaaa8ad26b',
        '5766d063-6d49-41a6-ab25-6e8dbd381d94',
        'cba5c631-0bc5-44ec-a7d8-a8faf0e991c4'
      );
    `);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING');
  }
  if (!versions.has(4)) {
    await client.query(`
      ALTER TABLE squirl_messages DROP CONSTRAINT IF EXISTS squirl_messages_role_check;
      ALTER TABLE squirl_messages ADD CONSTRAINT squirl_messages_role_check
        CHECK (role IN ('user','assistant','tool','activity'));
    `);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (4) ON CONFLICT DO NOTHING');
  }
  if (!versions.has(5)) {
    await client.query(`
      ALTER TABLE squirl_messages ADD COLUMN IF NOT EXISTS timeline_order numeric(30,10);
      UPDATE squirl_messages SET timeline_order=sequence WHERE timeline_order IS NULL;
      ALTER TABLE squirl_messages ALTER COLUMN timeline_order SET NOT NULL;

      CREATE OR REPLACE FUNCTION squirl_messages_set_timeline_order()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.timeline_order IS NULL THEN NEW.timeline_order := NEW.sequence::numeric;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS squirl_messages_timeline_order ON squirl_messages;
      CREATE TRIGGER squirl_messages_timeline_order
        BEFORE INSERT ON squirl_messages
        FOR EACH ROW EXECUTE FUNCTION squirl_messages_set_timeline_order();
      CREATE INDEX IF NOT EXISTS squirl_messages_room_timeline
        ON squirl_messages (room_id, timeline_order, sequence);

      WITH workflow_launches AS (
        SELECT launch.id, workflow.timeline_order - 0.5::numeric AS repaired_order
        FROM squirl_messages launch
        JOIN squirl_messages workflow
          ON workflow.room_id=launch.room_id
         AND workflow.role='tool'
         AND workflow.participant_id IS NOT DISTINCT FROM launch.participant_id
         AND workflow.payload->>'toolName' ~ '(^|:)Workflow$'
         AND substring(workflow.content from 'Task ID:[[:space:]]*([^[:space:]]+)')
             = substring(launch.content from 'task \`([^\`]+)\`')
        WHERE launch.role='assistant'
          AND launch.id ~ '-[0-9]+$'
          AND launch.content ~* 'workflow.*running in the background'
      )
      UPDATE squirl_messages message
      SET timeline_order=workflow_launches.repaired_order
      FROM workflow_launches
      WHERE message.id=workflow_launches.id;
    `);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (5) ON CONFLICT DO NOTHING');
  }
  if (!versions.has(6)) {
    await client.query(`
      -- Recovery turns are operational scaffolding, not permanent failures. If
      -- their authoritative source activity eventually succeeded, retire them.
      UPDATE squirl_turns recovery
      SET status='cancelled', finished_at=COALESCE(finished_at, now()),
          lease_owner=NULL, lease_expires_at=NULL, last_error=NULL
      WHERE recovery.status IN ('queued','interrupted','failed')
        AND EXISTS (
          SELECT 1 FROM squirl_messages source
          WHERE source.room_id=recovery.room_id
            AND source.id=recovery.metadata->>'sourceActivityId'
            AND source.role='activity'
            AND source.payload->'activity'->>'state'='succeeded'
        );

      -- This result was first materialized during restart reconciliation, after
      -- Claude had already posted the native report. Its relationship is exact,
      -- so repair it transactionally to immediately precede that report.
      WITH misplaced AS (
        SELECT result.id, result.room_id, final.timeline_order AS final_order,
          COALESCE((
            SELECT max(previous.timeline_order)
            FROM squirl_messages previous
            WHERE previous.room_id=result.room_id
              AND previous.timeline_order < final.timeline_order
          ), final.timeline_order - 1::numeric) AS previous_order
        FROM squirl_messages result
        JOIN squirl_messages final
          ON final.room_id=result.room_id
         AND final.id='cc-squirl-fable-b6cae74e-20f5-47ec-85fd-73659570fd66'
        WHERE result.id='activity-job-cc-squirl-fable-wd8ujffoh-result'
          AND result.timeline_order > final.timeline_order
      )
      UPDATE squirl_messages result
      SET timeline_order=(misplaced.previous_order + misplaced.final_order) / 2::numeric
      FROM misplaced
      WHERE result.id=misplaced.id AND result.room_id=misplaced.room_id;
    `);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (6) ON CONFLICT DO NOTHING');
  }
  if (!versions.has(7)) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS squirl_pipeline_traces (
        room_id uuid NOT NULL REFERENCES squirl_rooms(id) ON DELETE CASCADE,
        turn_id uuid NOT NULL REFERENCES squirl_turns(id) ON DELETE CASCADE,
        assistant_message_id text REFERENCES squirl_messages(id) ON DELETE CASCADE,
        trace jsonb NOT NULL,
        started_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS squirl_pipeline_traces_recent
        ON squirl_pipeline_traces (room_id, started_at DESC, updated_at DESC);
    `);
    await client.query('INSERT INTO squirl_schema_migrations(version) VALUES (7) ON CONFLICT DO NOTHING');
  }
}
