// Codex adapter: ONE process per turn. The first turn runs `codex exec`; later turns continue
// the conversation via `codex exec resume <thread_id>`. The thread id is captured from the
// `thread.started` event (surfaced by the parser as session-status.sessionId).
//
// The prompt is fed via stdin (`-` positional) to avoid argv escaping/length limits.

import { createCodexParser } from '../parse/codex-stream.js';
import type { AgentDescriptor, AgentTransport, SpawnHandle } from '../types.js';
import { BaseAgentSession } from './base.js';

export class CodexAdapter extends BaseAgentSession {
  private threadId: string | undefined;
  private current: SpawnHandle | null = null;

  constructor(descriptor: AgentDescriptor, transport: AgentTransport) {
    super(descriptor, transport);
    this.threadId = descriptor.sessionId;
  }

  buildArgs(): string[] {
    const d = this.descriptor;
    const args = ['exec'];
    if (this.threadId) args.push('resume', this.threadId);
    args.push('-'); // read the prompt from stdin
    args.push('--json', '--sandbox', d.sandbox ?? 'read-only', '-C', d.cwd, '--skip-git-repo-check');
    if (d.model) args.push('--model', d.model);
    if (d.effort) args.push('--config', `model_reasoning_effort="${d.effort}"`);
    return args;
  }

  async start(): Promise<void> {
    // Nothing to spawn until the first turn — Codex is per-turn.
    this.setStatus('ready');
  }

  async send(text: string): Promise<void> {
    const parser = createCodexParser({ participantId: this.descriptor.id, newMessageId: () => this.nextMessageId() });
    const handle = await this.transport.spawn({
      command: this.descriptor.bin ?? 'codex',
      args: this.buildArgs(),
      cwd: this.descriptor.cwd,
    });
    this.current = handle;
    this.setStatus('busy');

    handle.onStdout((line) => {
      for (const event of parser.push(line)) {
        if (event.type === 'session-status' && event.sessionId) {
          this.threadId = event.sessionId;
          this.descriptor.sessionId = event.sessionId;
        }
        this.trackStatus(event);
        this.emit(event);
      }
    });
    handle.exited.then(({ code }) => {
      for (const event of parser.end(code)) this.emit(event);
      this.current = null;
      if (this.status === 'busy') this.setStatus('ready');
    });

    handle.stdin.write(text);
    handle.stdin.end();
  }

  async interrupt(): Promise<void> {
    this.current?.kill('SIGTERM');
    this.current = null;
  }

  async stop(): Promise<void> {
    this.current?.kill('SIGTERM');
    this.current = null;
    this.setStatus('stopped');
  }
}
