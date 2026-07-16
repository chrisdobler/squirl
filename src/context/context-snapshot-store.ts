import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSnapshotDiscs, type ContextSnapshot } from './context-snapshot.js';
import { DEFAULT_COMPLETION_RESERVE_TOKENS } from './truncation.js';

const SCHEMA_VERSION = 1;

interface StoredContextSnapshot {
  version: number;
  workingDir: string;
  snapshot: ContextSnapshot;
}

function snapshotDirectory(): string {
  return join(homedir(), '.squirl', 'context-snapshots');
}

export function contextSnapshotPath(workingDir: string): string {
  const workspace = resolve(workingDir);
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  return join(snapshotDirectory(), `${key}.json`);
}

function isSnapshot(value: unknown): value is ContextSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ContextSnapshot>;
  return candidate.origin === 'exact'
    && typeof candidate.capturedAt === 'string'
    && typeof candidate.modelId === 'string'
    && typeof candidate.contextWindow === 'number'
    && typeof candidate.approximateTokens === 'number'
    && typeof candidate.renderedDocument === 'string'
    && Array.isArray(candidate.sections)
    && Array.isArray(candidate.discs);
}

export function loadContextSnapshot(workingDir: string): ContextSnapshot | null {
  const path = contextSnapshotPath(workingDir);
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredContextSnapshot>;
    if (stored.version !== SCHEMA_VERSION || stored.workingDir !== resolve(workingDir) || !isSnapshot(stored.snapshot)) return null;
    const snapshot = stored.snapshot;
    const sections = snapshot.sections.map((section) => section.label === 'Recalled memory'
      ? { ...section, category: 'memory' as const }
      : section);
    const completionReserveTokens = Math.min(
      Math.max(0, typeof snapshot.completionReserveTokens === 'number' ? snapshot.completionReserveTokens : DEFAULT_COMPLETION_RESERVE_TOKENS),
      Math.max(0, snapshot.contextWindow),
    );
    const promptBudgetTokens = Math.max(0, snapshot.contextWindow - completionReserveTokens);
    const promptAvailableTokens = Math.max(0, promptBudgetTokens - snapshot.approximateTokens);
    const promptOverageTokens = Math.max(0, snapshot.approximateTokens - promptBudgetTokens);
    return {
      ...snapshot,
      completionReserveTokens,
      promptBudgetTokens,
      promptAvailableTokens,
      promptOverageTokens,
      droppedEvidence: Array.isArray(snapshot.droppedEvidence) ? snapshot.droppedEvidence : [],
      sections,
      discs: buildSnapshotDiscs(sections, snapshot.renderedDocument.length, snapshot.approximateTokens, snapshot.contextWindow, 100, completionReserveTokens),
    };
  } catch {
    return null;
  }
}

export function saveContextSnapshot(workingDir: string, snapshot: ContextSnapshot): void {
  if (snapshot.origin !== 'exact') return;
  const directory = snapshotDirectory();
  const path = contextSnapshotPath(workingDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const stored: StoredContextSnapshot = { version: SCHEMA_VERSION, workingDir: resolve(workingDir), snapshot };
    writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    rmSync(temporary, { force: true });
  }
}
