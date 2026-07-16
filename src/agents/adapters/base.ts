import type { AgentDescriptor, AgentEvent, AgentSession, AgentStatus, AgentTransport } from '../types.js';
import { randomUUID } from 'node:crypto';

/** Shared listener/status plumbing for the concrete adapters. */
export abstract class BaseAgentSession implements AgentSession {
  status: AgentStatus = 'starting';
  protected listeners = new Set<(event: AgentEvent) => void>();

  constructor(readonly descriptor: AgentDescriptor, protected readonly transport: AgentTransport) {}

  abstract start(): Promise<void>;
  abstract send(text: string): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract stop(): Promise<void>;

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  protected emit(event: AgentEvent): void {
    for (const handler of this.listeners) handler(event);
  }

  protected setStatus(status: AgentStatus): void {
    this.status = status;
  }

  protected nextMessageId(): string {
    // Adapter instances are recreated on process restarts. A local counter would reuse
    // durable transcript ids and update an older message's payload at its old sequence.
    return `${this.descriptor.id}-${randomUUID()}`;
  }

  /** Apply status side-effects from parsed events shared by both adapters. */
  protected trackStatus(event: AgentEvent): void {
    if (event.type === 'session-status' && event.status === 'ready' && this.status === 'starting') {
      this.setStatus('ready');
    } else if (event.type === 'turn-end') {
      this.setStatus('ready');
    } else if (event.type === 'error') {
      this.setStatus('error');
    }
  }
}
