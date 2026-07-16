import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';

import type { Message } from '../types.js';
import type { AgentDescriptor } from './types.js';

const require = createRequire(import.meta.url);

/** pnpm can materialize node-pty's prebuilt helper without its executable bit. */
export function ensurePtyHelperExecutable(): void {
  if (platform() === 'win32') return;
  let root: string;
  try { root = dirname(require.resolve('node-pty/package.json')); } catch { return; }
  for (const path of [
    join(root, 'prebuilds', `${platform()}-${arch()}`, 'spawn-helper'),
    join(root, 'build', 'Release', 'spawn-helper'),
  ]) {
    if (!existsSync(path)) continue;
    try { chmodSync(path, 0o755); } catch { /* Packaged helpers may already be read-only and executable. */ }
  }
}

export interface TerminalSnapshot {
  participantId: string;
  capability: string;
  output: string;
  cols: number;
  rows: number;
}

export interface TerminalTranscriptBaseline {
  path: string | null;
  offset: number;
}

interface ManagedTerminal extends TerminalSnapshot {
  descriptor: AgentDescriptor;
  process: pty.IPty;
  baseline: TerminalTranscriptBaseline;
}

export function interactiveAgentArgs(descriptor: AgentDescriptor): string[] {
  if (!descriptor.sessionId) throw new Error(`@${descriptor.id} has no provider session to resume yet.`);
  if (descriptor.kind === 'claude-code') {
    const args = ['--resume', descriptor.sessionId, '--permission-mode', descriptor.permissionMode ?? 'acceptEdits', '--add-dir', descriptor.cwd];
    if (descriptor.model) args.push('--model', descriptor.model);
    if (descriptor.effort) args.push('--effort', descriptor.effort);
    if (descriptor.bare) args.push('--bare');
    return args;
  }
  if (descriptor.kind === 'codex') {
    const args = ['resume', descriptor.sessionId, '--sandbox', descriptor.sandbox ?? 'workspace-write', '--ask-for-approval', descriptor.approvalPolicy ?? 'on-request', '-C', descriptor.cwd];
    if (descriptor.model) args.push('--model', descriptor.model);
    if (descriptor.effort) args.push('--config', `model_reasoning_effort="${descriptor.effort}"`);
    return args;
  }
  // Unlike `--session`, this also handles a newly-created session that has not
  // produced a session file yet. Existing project sessions still resume by ID.
  const args = ['--session-id', descriptor.sessionId];
  if (descriptor.model) args.push('--model', descriptor.model);
  if (descriptor.effort) args.push('--thinking', descriptor.effort);
  if (descriptor.piToolMode === 'read-only') args.push('--tools', 'read,grep,find,ls');
  if (descriptor.piToolMode !== 'read-only') {
    const compiled = fileURLToPath(new URL('./pi-permission-gate.js', import.meta.url));
    const source = fileURLToPath(new URL('./pi-permission-gate.ts', import.meta.url));
    args.push('--extension', existsSync(compiled) ? compiled : source);
  }
  return args;
}

function walkFor(root: string, predicate: (name: string) => boolean, depth = 0): string | null {
  if (depth > 5 || !existsSync(root)) return null;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && predicate(entry.name)) return path;
    if (entry.isDirectory()) {
      const match = walkFor(path, predicate, depth + 1);
      if (match) return match;
    }
  }
  return null;
}

export function findAgentSessionFile(descriptor: AgentDescriptor): string | null {
  if (!descriptor.sessionId) return null;
  if (descriptor.kind === 'claude-code') return walkFor(join(homedir(), '.claude', 'projects'), (name) => name === `${descriptor.sessionId}.jsonl`);
  if (descriptor.kind === 'codex') return walkFor(process.env.CODEX_HOME || join(homedir(), '.codex', 'sessions'), (name) => name.endsWith(`${descriptor.sessionId}.jsonl`));
  return walkFor(join(homedir(), '.pi', 'agent', 'sessions'), (name) => name.endsWith(`_${descriptor.sessionId}.jsonl`));
}

export function captureTerminalTranscriptBaseline(descriptor: AgentDescriptor): TerminalTranscriptBaseline {
  const path = findAgentSessionFile(descriptor);
  return { path, offset: path ? statSync(path).size : 0 };
}

function textBlocks(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const row = block as Record<string, unknown>;
    if (row.type === 'text' || row.type === 'input_text' || row.type === 'output_text') {
      return typeof row.text === 'string' ? [row.text] : [];
    }
    return [];
  }).join('\n').trim();
}

export function importTerminalTranscript(descriptor: AgentDescriptor, baseline: TerminalTranscriptBaseline): Message[] {
  if (!baseline.path || !existsSync(baseline.path)) return [];
  const content = readFileSync(baseline.path, 'utf8').slice(baseline.offset);
  const messages: Message[] = [];
  const messageIndex = new Map<string, number>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    let id = typeof entry.uuid === 'string' ? entry.uuid : typeof entry.id === 'string' ? entry.id : '';
    let role: unknown;
    let body: unknown;
    if (descriptor.kind === 'codex') {
      if (entry.type !== 'response_item') continue;
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.type !== 'message') continue;
      id ||= typeof payload.id === 'string' ? payload.id : '';
      role = payload.role;
      body = payload.content;
    } else {
      if (descriptor.kind === 'pi' && entry.type !== 'message') continue;
      if (descriptor.kind === 'claude-code' && entry.type !== 'user' && entry.type !== 'assistant') continue;
      const message = entry.message as Record<string, unknown> | undefined;
      if (typeof message?.id === 'string') id = message.id;
      role = message?.role ?? entry.type;
      body = message?.content;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textBlocks(body);
    if (!text || text === '/compact' || text === '/exit') continue;
    const stableId = `terminal-${descriptor.kind}-${id || crypto.randomUUID()}`;
    const imported: Message = role === 'user'
      ? { id: stableId, role: 'user', content: text, participantId: descriptor.id }
      : { id: stableId, role: 'assistant', content: text, participantId: descriptor.id };
    const previousIndex = messageIndex.get(stableId);
    if (previousIndex != null) messages[previousIndex] = imported;
    else {
      messageIndex.set(stableId, messages.length);
      messages.push(imported);
    }
  }
  return messages;
}

export class AgentTerminalManager {
  private terminals = new Map<string, ManagedTerminal>();

  constructor(
    private readonly onOutput: (participantId: string, data: string) => void,
    private readonly onExit: (participantId: string, code: number) => void,
    private readonly spawnPty: typeof pty.spawn = pty.spawn,
  ) {}

  start(descriptor: AgentDescriptor, cols = 100, rows = 30): TerminalSnapshot {
    const existing = this.terminals.get(descriptor.id);
    if (existing) return { participantId: existing.participantId, capability: existing.capability, output: existing.output, cols: existing.cols, rows: existing.rows };
    ensurePtyHelperExecutable();
    const process = this.spawnPty(descriptor.bin ?? (descriptor.kind === 'claude-code' ? 'claude' : descriptor.kind === 'codex' ? 'codex' : 'pi'), interactiveAgentArgs(descriptor), {
      name: 'xterm-256color', cols, rows, cwd: descriptor.cwd,
      env: {
        ...globalThis.process.env, TERM: 'xterm-256color',
        ...(descriptor.kind === 'pi' ? { SQUIRL_PI_APPROVAL_MODE: descriptor.piApprovalMode ?? 'acceptEdits' } : {}),
      } as Record<string, string>,
    });
    const terminal: ManagedTerminal = {
      descriptor, process, participantId: descriptor.id, capability: crypto.randomUUID(), output: '', cols, rows,
      baseline: captureTerminalTranscriptBaseline(descriptor),
    };
    this.terminals.set(descriptor.id, terminal);
    process.onData((data) => {
      terminal.output = `${terminal.output}${data}`.slice(-262_144);
      this.onOutput(descriptor.id, data);
    });
    process.onExit(({ exitCode }) => {
      if (this.terminals.get(descriptor.id)?.process !== process) return;
      this.onExit(descriptor.id, exitCode);
    });
    return { participantId: descriptor.id, capability: terminal.capability, output: terminal.output, cols, rows };
  }

  get(id: string): ManagedTerminal | undefined { return this.terminals.get(id); }

  write(id: string, capability: string, data: string): void {
    const terminal = this.authorize(id, capability);
    terminal.process.write(data);
  }

  resize(id: string, capability: string, cols: number, rows: number): void {
    const terminal = this.authorize(id, capability);
    terminal.cols = Math.max(20, Math.min(400, Math.floor(cols)));
    terminal.rows = Math.max(5, Math.min(200, Math.floor(rows)));
    terminal.process.resize(terminal.cols, terminal.rows);
  }

  async stop(id: string, capability?: string): Promise<{ descriptor: AgentDescriptor; baseline: TerminalTranscriptBaseline }> {
    const terminal = capability ? this.authorize(id, capability) : this.terminals.get(id);
    if (!terminal) throw new Error(`No terminal session for @${id}.`);
    this.terminals.delete(id);
    try { terminal.process.write('\x03'); } catch { /* already exited */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { terminal.process.kill(); } catch { /* already exited */ }
    return { descriptor: terminal.descriptor, baseline: terminal.baseline };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map((id) => this.stop(id).then(() => undefined).catch(() => undefined)));
  }

  private authorize(id: string, capability: string): ManagedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.capability !== capability) throw new Error('Invalid terminal capability.');
    return terminal;
  }
}
