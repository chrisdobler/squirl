import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { PendingDelegationConfirmation } from './delegation.js';

export interface HandoffConfirmationInteraction {
  id: string;
  kind: 'handoff-confirmation';
  pending: PendingDelegationConfirmation;
  originalRequest: string;
  parentTurnId?: string;
  createdAt: string;
  expiresAt: string;
}

export type SystemInteraction = HandoffConfirmationInteraction;

interface StoredSystemInteractions {
  version: 1;
  workingDir: string;
  interactions: SystemInteraction[];
}

function storagePath(workingDir: string): string {
  const key = createHash('sha256').update(resolve(workingDir)).digest('hex').slice(0, 24);
  return join(homedir(), '.squirl', 'system-interactions', `${key}.json`);
}

function validPending(value: unknown): value is PendingDelegationConfirmation {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingDelegationConfirmation>;
  const action = pending.action as Record<string, unknown> | undefined;
  const validAction = action === undefined || (
    action !== null && typeof action === 'object'
    && action.type === 'handoff'
    && typeof action.targetId === 'string' && Array.isArray(pending.targetIds) && pending.targetIds.includes(action.targetId)
    && typeof action.task === 'string' && action.task.trim().length > 0
    && (action.context === undefined || typeof action.context === 'string')
    && (action.successCriteria === undefined || typeof action.successCriteria === 'string')
  );
  return typeof pending.id === 'string'
    && Array.isArray(pending.targetIds) && pending.targetIds.length > 0 && pending.targetIds.every((id) => typeof id === 'string' && id.length > 0)
    && typeof pending.task === 'string' && pending.task.trim().length > 0
    && typeof pending.originalRequest === 'string'
    && typeof pending.createdAt === 'string' && Number.isFinite(Date.parse(pending.createdAt))
    && typeof pending.expiresAt === 'string' && Number.isFinite(Date.parse(pending.expiresAt))
    && validAction;
}

function validInteraction(value: unknown): value is SystemInteraction {
  if (!value || typeof value !== 'object') return false;
  const interaction = value as Partial<SystemInteraction>;
  return interaction.kind === 'handoff-confirmation'
    && typeof interaction.id === 'string' && interaction.id.length > 0
    && validPending(interaction.pending)
    && typeof interaction.originalRequest === 'string'
    && typeof interaction.createdAt === 'string' && Number.isFinite(Date.parse(interaction.createdAt))
    && typeof interaction.expiresAt === 'string' && Number.isFinite(Date.parse(interaction.expiresAt))
    && (interaction.parentTurnId === undefined || typeof interaction.parentTurnId === 'string');
}

export function interactionFromPending(pending: PendingDelegationConfirmation, parentTurnId?: string): HandoffConfirmationInteraction {
  return {
    id: pending.id || randomUUID(),
    kind: 'handoff-confirmation',
    pending,
    originalRequest: pending.originalRequest,
    ...(parentTurnId ? { parentTurnId } : {}),
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

export function loadSystemInteractions(workingDir: string, now = new Date()): SystemInteraction[] {
  try {
    const stored = JSON.parse(readFileSync(storagePath(workingDir), 'utf8')) as Partial<StoredSystemInteractions>;
    if (stored.version !== 1 || resolve(stored.workingDir ?? '') !== resolve(workingDir) || !Array.isArray(stored.interactions)) return [];
    const interactions = stored.interactions.filter(validInteraction).filter((item) => Date.parse(item.expiresAt) > now.getTime())
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (interactions.length !== stored.interactions.length) saveSystemInteractions(workingDir, interactions);
    return interactions;
  } catch {
    return [];
  }
}

export function saveSystemInteractions(workingDir: string, interactions: SystemInteraction[]): void {
  const directory = join(homedir(), '.squirl', 'system-interactions');
  const path = storagePath(workingDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const stored: StoredSystemInteractions = { version: 1, workingDir: resolve(workingDir), interactions };
    writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
