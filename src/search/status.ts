import type { IngestStatus } from './types.js';

export type StatusListener = (status: IngestStatus) => void;

export class StatusEmitter {
  private listeners = new Set<StatusListener>();
  current: IngestStatus = { phase: 'idle', pending: 0 };

  on(listener: StatusListener): void { this.listeners.add(listener); }
  off(listener: StatusListener): void { this.listeners.delete(listener); }

  update(status: IngestStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }
}
