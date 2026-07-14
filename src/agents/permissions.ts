import type { AgentInteractionRequest, AgentInteractionResponse } from './types.js';

export type PermissionDecision = NonNullable<AgentInteractionResponse['decision']>;

interface PendingPermission {
  request: Extract<AgentInteractionRequest, { method: 'permission' }>;
  resolve: (decision: PermissionDecision) => void;
}

/** In-memory only permission queue shared by interactive adapters. */
export class SessionPermissionBroker {
  private pending = new Map<string, PendingPermission>();

  constructor(private readonly publish: (request: PendingPermission['request']) => void) {}

  request(request: Omit<PendingPermission['request'], 'id' | 'method'> & { id?: string }): Promise<PermissionDecision> {
    const full: PendingPermission['request'] = { ...request, id: request.id ?? crypto.randomUUID(), method: 'permission' };
    return new Promise((resolve) => {
      this.pending.set(full.id, { request: full, resolve });
      this.publish(full);
    });
  }

  respond(id: string, response: AgentInteractionResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return; // stale/duplicate browser responses are intentionally idempotent
    this.pending.delete(id);
    let decision = response.decision ?? 'deny';
    if (decision === 'allow-session' && !pending.request.sessionScope) decision = 'allow-once';
    pending.resolve(decision);
  }

  denyAll(): void {
    const values = [...this.pending.values()];
    this.pending.clear();
    for (const pending of values) pending.resolve('deny');
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}

export function boundedInput(value: unknown, max = 4000): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}
