// PI adapter: one persistent `pi --mode rpc` process per room participant.

import { createPiParser } from '../parse/pi-stream.js';
import type { AgentDescriptor, AgentInteractionResponse, AgentTransport, SpawnHandle, StreamParser } from '../types.js';
import { BaseAgentSession } from './base.js';

export class PiAdapter extends BaseAgentSession {
  private handle: SpawnHandle | null = null;
  private parser: StreamParser;
  private pendingInteractions = new Set<string>();
  private startupResolve: (() => void) | null = null;
  private startupReject: ((error: Error) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(descriptor: AgentDescriptor, transport: AgentTransport) {
    super(descriptor, transport);
    this.parser = createPiParser({
      participantId: descriptor.id,
      newMessageId: () => this.nextMessageId(),
      onSettled: () => this.write({ type: 'get_session_stats', id: `stats-${Date.now()}` }),
      onUnsupportedInteraction: (id) => this.write({ type: 'extension_ui_response', id, cancelled: true }),
    });
  }

  buildArgs(): string[] {
    const d = this.descriptor;
    const args = ['--mode', 'rpc'];
    if (d.model) args.push('--model', d.model);
    if (d.effort) args.push('--thinking', d.effort);
    if (d.sessionId) args.push('--session', d.sessionId);
    if (d.piToolMode === 'read-only') args.push('--tools', 'read,grep,find,ls');
    return args;
  }

  private write(value: Record<string, unknown>): void {
    if (!this.handle) return;
    this.handle.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async start(): Promise<void> {
    const handle = await this.transport.spawn({
      command: this.descriptor.bin ?? 'pi',
      args: this.buildArgs(),
      cwd: this.descriptor.cwd,
    });
    this.handle = handle;
    const startup = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    let stderr = '';
    handle.onStderr((line) => { stderr = `${stderr}\n${line}`.trim().slice(-4000); });
    handle.onStdout((line) => {
      for (const event of this.parser.push(line)) {
        if (event.type === 'interaction-request') this.pendingInteractions.add(event.request.id);
        if (event.type === 'session-status' && event.sessionId) this.descriptor.sessionId = event.sessionId;
        if (event.type === 'session-status' && event.status === 'ready') {
          if (this.startupTimer) clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this.startupResolve?.();
          this.startupResolve = null;
          this.startupReject = null;
        }
        if (event.type === 'error' && this.status === 'starting') {
          if (this.startupTimer) clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this.startupReject?.(new Error(event.message));
          this.startupResolve = null;
          this.startupReject = null;
        }
        this.trackStatus(event);
        this.emit(event);
      }
    });
    handle.exited.then(({ code }) => {
      for (const event of this.parser.end(code)) this.emit(event);
      if (this.startupReject) {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = null;
        const detail = stderr || (code == null ? 'The PI executable could not be started.' : `PI exited with code ${code}.`);
        this.startupReject(new Error(`Could not start PI: ${detail}`));
        this.startupResolve = null;
        this.startupReject = null;
      }
      this.setStatus('stopped');
      this.emit({ type: 'exit', participantId: this.descriptor.id, code });
    });
    this.startupTimer = setTimeout(() => {
      if (!this.startupReject) return;
      this.startupReject(new Error(`PI RPC did not become ready within 15 seconds.${stderr ? ` ${stderr}` : ''}`));
      this.startupResolve = null;
      this.startupReject = null;
      handle.kill('SIGTERM');
    }, 15_000);
    this.write({ type: 'get_state', id: 'squirl-startup' });
    await startup;
  }

  async send(text: string): Promise<void> {
    if (!this.handle) throw new Error(`Agent ${this.descriptor.id} is not started`);
    this.setStatus('busy');
    this.write({ type: 'prompt', id: `prompt-${Date.now()}`, message: text });
  }

  async interrupt(): Promise<void> {
    this.write({ type: 'abort', id: `abort-${Date.now()}` });
  }

  async respondToInteraction(id: string, response: AgentInteractionResponse): Promise<void> {
    if (!this.pendingInteractions.has(id)) throw new Error(`No pending PI interaction "${id}"`);
    this.pendingInteractions.delete(id);
    this.write({ type: 'extension_ui_response', id, ...response });
  }

  async stop(): Promise<void> {
    for (const id of this.pendingInteractions) this.write({ type: 'extension_ui_response', id, cancelled: true });
    this.pendingInteractions.clear();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.handle?.stdin.end();
    this.handle?.kill('SIGTERM');
    this.handle = null;
    this.setStatus('stopped');
  }
}
