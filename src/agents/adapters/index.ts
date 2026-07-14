import type { AgentDescriptor, AgentSession, AgentTransport } from '../types.js';
import { LocalSpawnTransport } from '../transport/local-spawn.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { PiAdapter } from './pi.js';

/** Build an AgentSession for a descriptor. Defaults to a local subprocess transport. */
export function createAgentSession(descriptor: AgentDescriptor, transport?: AgentTransport): AgentSession {
  const t = transport ?? new LocalSpawnTransport();
  switch (descriptor.kind) {
    case 'claude-code':
      return new ClaudeCodeAdapter(descriptor, t);
    case 'codex':
      return new CodexAdapter(descriptor, t);
    case 'pi':
      return new PiAdapter(descriptor, t);
    default:
      throw new Error(`Unknown agent kind: ${(descriptor as AgentDescriptor).kind}`);
  }
}

export { ClaudeCodeAdapter } from './claude-code.js';
export { CodexAdapter } from './codex.js';
export { PiAdapter } from './pi.js';
