// Placeholder for the future remote transport. It satisfies AgentTransport so the rest of the
// system is already transport-agnostic; the real implementation would build an
// `ssh [-i identity] user@host -- <command>` argv and reuse the line splitting from
// LocalSpawnTransport. Spawning is intentionally not implemented yet.

import type { AgentTransport, SpawnHandle, SpawnSpec } from '../types.js';

export interface SshTransportOptions {
  host: string;
  user?: string;
  identity?: string;
}

export class SshTransport implements AgentTransport {
  readonly kind = 'ssh' as const;

  constructor(private readonly options: SshTransportOptions) {}

  async spawn(_spec: SpawnSpec): Promise<SpawnHandle> {
    throw new Error(`SSH transport is not implemented yet (host: ${this.options.host}). Use a local subprocess for now.`);
  }
}
