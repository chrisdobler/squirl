import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ParticipantContextPreview } from './context-preview.js';

const SCHEMA_VERSION = 1;

interface StoredParticipantContextPreviews {
  version: number;
  workingDir: string;
  previews: Record<string, ParticipantContextPreview>;
}

function previewDirectory(): string {
  return join(homedir(), '.squirl', 'context-previews');
}

export function participantContextPreviewPath(workingDir: string): string {
  const workspace = resolve(workingDir);
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  return join(previewDirectory(), `${key}.json`);
}

function isPreview(value: unknown): value is ParticipantContextPreview {
  if (!value || typeof value !== 'object') return false;
  const preview = value as Partial<ParticipantContextPreview>;
  return typeof preview.participantId === 'string'
    && (preview.modelId === null || typeof preview.modelId === 'string')
    && typeof preview.source === 'string'
    && typeof preview.fidelity === 'string'
    && (preview.matrixMode === 'categorized' || preview.matrixMode === 'usage')
    && (preview.capturedAt === null || typeof preview.capturedAt === 'string')
    && (preview.usedTokens === null || typeof preview.usedTokens === 'number')
    && (preview.contextWindow === null || typeof preview.contextWindow === 'number')
    && !!preview.buckets
    && Array.isArray(preview.discs)
    && preview.discs.length === 100;
}

export function loadParticipantContextPreviews(workingDir: string): Record<string, ParticipantContextPreview> {
  const path = participantContextPreviewPath(workingDir);
  if (!existsSync(path)) return {};
  try {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredParticipantContextPreviews>;
    if (stored.version !== SCHEMA_VERSION || stored.workingDir !== resolve(workingDir) || !stored.previews) return {};
    return Object.fromEntries(Object.entries(stored.previews).filter(([, preview]) => isPreview(preview)));
  } catch {
    return {};
  }
}

export function saveParticipantContextPreviews(workingDir: string, previews: Record<string, ParticipantContextPreview>): void {
  const directory = previewDirectory();
  const path = participantContextPreviewPath(workingDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const stored: StoredParticipantContextPreviews = { version: SCHEMA_VERSION, workingDir: resolve(workingDir), previews };
    writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    rmSync(temporary, { force: true });
  }
}
