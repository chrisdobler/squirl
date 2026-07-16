import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { LogEntry } from '../history.js';
import type { PostgresRoomStore } from './postgres-room-store.js';

function legacyFiles(historyDir: string): string[] {
  if (!existsSync(historyDir)) return [];
  const root = readdirSync(historyDir).filter((name) => name.endsWith('.jsonl')).map((name) => join(historyDir, name));
  const imports = join(historyDir, 'imports');
  const imported = existsSync(imports)
    ? readdirSync(imports).filter((name) => name.endsWith('.jsonl')).map((name) => join(imports, name))
    : [];
  return [...root, ...imported].sort();
}

function entriesFrom(files: string[]): LogEntry[] {
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as LogEntry;
      return value?.message?.id && Number.isFinite(Date.parse(value.timestamp)) ? [value] : [];
    } catch { return []; }
  })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function importAndArchiveJsonl(store: PostgresRoomStore, historyDir = join(homedir(), '.squirl', 'history')): Promise<{ imported: number; archivePath?: string }> {
  const files = legacyFiles(historyDir);
  if (files.length === 0) return { imported: 0 };
  const digest = createHash('sha256');
  for (const file of files) digest.update(file).update('\0').update(readFileSync(file));
  const hash = digest.digest('hex');
  const source = 'legacy-jsonl';
  const entries = entriesFrom(files);
  const client = await store.pool.connect();
  let imported = 0;
  let releaseError: Error | boolean | undefined;
  try {
    await client.query('BEGIN');
    const seen = await client.query('SELECT 1 FROM squirl_imports WHERE source=$1 AND digest=$2', [source, hash]);
    if (seen.rowCount) { await client.query('ROLLBACK'); return { imported: 0 }; }
    for (const entry of entries) {
      const message = entry.message;
      const result = await client.query(`INSERT INTO squirl_messages(id,room_id,role,participant_id,content,payload,created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (id) DO NOTHING`,
      [message.id, store.roomId, message.role, message.participantId ?? null, message.content, JSON.stringify(message), entry.timestamp]);
      imported += result.rowCount ?? 0;
    }
    await client.query('INSERT INTO squirl_imports(source,digest,message_count) VALUES ($1,$2,$3)', [source, hash, imported]);
    await client.query('COMMIT');
  } catch (error) {
    releaseError = error instanceof Error ? error : true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(releaseError); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(historyDir, 'migrated', stamp);
  mkdirSync(archivePath, { recursive: true });
  for (const file of files) {
    const group = file.includes(`${join(historyDir, 'imports')}/`) ? 'imports-' : '';
    renameSync(file, join(archivePath, `${group}${basename(file)}`));
  }
  return { imported, archivePath };
}
