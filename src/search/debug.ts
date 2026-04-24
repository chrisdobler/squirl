import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_PATH = join(homedir(), '.squirl', 'search.log');
const DEBUG = !!process.env.SQUIRL_DEBUG;

export function searchLog(label: string, data?: unknown): void {
  if (!DEBUG) return;
  try {
    mkdirSync(join(homedir(), '.squirl'), { recursive: true });
    const ts = new Date().toISOString();
    const body = data !== undefined ? ' ' + JSON.stringify(data) : '';
    appendFileSync(LOG_PATH, `[${ts}] ${label}${body}\n`);
  } catch { /* ignore */ }
}
