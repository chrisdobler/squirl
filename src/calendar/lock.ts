import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_STALE_MS = 2 * 60_000;
const DEFAULT_WAIT_MS = 30_000;

export const calendarSyncLockPath = () => join(homedir(), '.squirl', 'calendar-sync.lock');

function ownerAlive(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number') return false;
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stale(path: string, staleMs: number): boolean {
  try {
    return !ownerAlive(path) || Date.now() - statSync(path).mtimeMs >= staleMs;
  } catch {
    return true;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function withCalendarSyncLock<T>(work: () => Promise<T>, options: {
  path?: string;
  waitMs?: number;
  staleMs?: number;
  retryMs?: number;
} = {}): Promise<T> {
  const path = options.path ?? calendarSyncLockPath();
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? 50;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { mode: 0o600 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (stale(path, staleMs)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the calendar synchronization lock.');
      await wait(retryMs);
    }
  }

  try {
    return await work();
  } finally {
    try {
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { token?: unknown };
        if (owner.token === token) rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A later run can reclaim an unreadable or abandoned lock.
    }
  }
}
