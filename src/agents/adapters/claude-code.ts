// Claude Code adapter: ONE long-lived process. Turns are fed as stream-json user messages on
// stdin; events stream back on stdout. We feed turns via stdin (never as a positional prompt)
// because --allowedTools/--add-dir are variadic and would otherwise swallow the prompt.
//
// Auth note: we do NOT pass --bare by default — it disables OAuth/keychain and requires
// ANTHROPIC_API_KEY. --include-partial-messages is always on so text streams as tokens.

import { createClaudeParser } from '../parse/claude-stream.js';
import type { AgentDescriptor, AgentTransport, SpawnHandle, StreamParser } from '../types.js';
import { BaseAgentSession } from './base.js';

export class ClaudeCodeAdapter extends BaseAgentSession {
  private handle: SpawnHandle | null = null;
  private parser: StreamParser;

  constructor(descriptor: AgentDescriptor, transport: AgentTransport) {
    super(descriptor, transport);
    this.parser = createClaudeParser({ participantId: descriptor.id, newMessageId: () => this.nextMessageId() });
  }

  buildArgs(): string[] {
    const d = this.descriptor;
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', d.permissionMode ?? 'default',
    ];
    if (d.model) args.push('--model', d.model);
    if (d.bare) args.push('--bare');
    if (d.sessionId) args.push('--resume', d.sessionId);
    args.push('--add-dir', d.cwd);
    return args;
  }

  async start(): Promise<void> {
    const handle = await this.transport.spawn({
      command: this.descriptor.bin ?? 'claude',
      args: this.buildArgs(),
      cwd: this.descriptor.cwd,
    });
    this.handle = handle;
    handle.onStdout((line) => {
      for (const event of this.parser.push(line)) {
        if (event.type === 'session-status' && event.sessionId) this.descriptor.sessionId = event.sessionId;
        this.trackStatus(event);
        this.emit(event);
      }
    });
    handle.exited.then(({ code }) => {
      for (const event of this.parser.end(code)) this.emit(event);
      this.setStatus('stopped');
      this.emit({ type: 'exit', participantId: this.descriptor.id, code });
    });
    this.setStatus('ready');
  }

  async send(text: string): Promise<void> {
    if (!this.handle) throw new Error(`Agent ${this.descriptor.id} is not started`);
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    this.handle.stdin.write(`${payload}\n`);
    this.setStatus('busy');
  }

  async interrupt(): Promise<void> {
    // MVP: no clean in-stream interrupt; restart-on-resume is a future enhancement.
    // Killing would drop the session, so interrupt is a no-op until the control protocol is wired.
  }

  async stop(): Promise<void> {
    this.handle?.stdin.end();
    this.handle?.kill('SIGTERM');
    this.setStatus('stopped');
  }
}
