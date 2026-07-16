import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import * as pty from 'node-pty';

import type { AgentDescriptor, AgentSession } from './types.js';
import { captureTerminalTranscriptBaseline, ensurePtyHelperExecutable, interactiveAgentArgs } from './terminal.js';

const TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function compactClaude(descriptor: AgentDescriptor): Promise<void> {
  const baseline = captureTerminalTranscriptBaseline(descriptor);
  if (!baseline.path) throw new Error(`Claude session ${descriptor.sessionId ?? ''} is not available on disk.`);
  ensurePtyHelperExecutable();
  const process = pty.spawn(descriptor.bin ?? 'claude', interactiveAgentArgs(descriptor), {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: descriptor.cwd,
    env: { ...globalThis.process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    process.write('/compact\r');
    await withTimeout(new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        try {
          const added = readFileSync(baseline.path!, 'utf8').slice(baseline.offset);
          if (/"(?:type|subtype)"\s*:\s*"[^"]*compact|"isCompactSummary"\s*:\s*true/i.test(added)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > TIMEOUT_MS) {
            clearInterval(timer);
            reject(new Error('Claude compaction did not create a compact summary.'));
          }
        } catch { /* The CLI may be replacing the session artifact. */ }
      }, 500);
    }), 'Claude compaction');
  } finally {
    try { process.write('/exit\r'); } catch { /* already exited */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { process.kill(); } catch { /* already exited */ }
  }
}

export async function compactCodex(descriptor: AgentDescriptor, spawnChild: typeof spawn = spawn): Promise<void> {
  if (!descriptor.sessionId) throw new Error(`@${descriptor.id} has no Codex thread to compact.`);
  const child = spawnChild(descriptor.bin ?? 'codex', ['app-server', '--stdio'], {
    cwd: descriptor.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let compactResolve: (() => void) | null = null;
  let compactReject: ((error: Error) => void) | null = null;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        const error = message.error as Record<string, unknown> | undefined;
        if (error) waiter.reject(new Error(String(error.message ?? 'Codex app-server request failed.')));
        else waiter.resolve(message.result);
      }
    }
    if (message.method === 'thread/compacted') compactResolve?.();
    if (message.method === 'error' && compactReject) {
      const params = message.params as Record<string, unknown> | undefined;
      compactReject(new Error(String(params?.message ?? 'Codex compaction failed.')));
    }
  });
  let nextId = 1;
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });
  try {
    await withTimeout(request('initialize', { clientInfo: { name: 'squirl', title: 'Squirl', version: '0.1.0' }, capabilities: null }), 'Codex initialization');
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    await withTimeout(request('thread/resume', {
      threadId: descriptor.sessionId, cwd: descriptor.cwd, model: descriptor.model ?? null,
      approvalPolicy: descriptor.approvalPolicy ?? 'on-request', sandbox: descriptor.sandbox ?? 'workspace-write',
    }), 'Codex thread resume');
    const completed = new Promise<void>((resolve, reject) => { compactResolve = resolve; compactReject = reject; });
    await withTimeout(request('thread/compact/start', { threadId: descriptor.sessionId }), 'Codex compact start');
    await withTimeout(completed, 'Codex compaction');
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? ` ${detail}` : ''}`);
  } finally {
    lines.close();
    child.kill('SIGTERM');
  }
}

export async function compactAgent(descriptor: AgentDescriptor, session?: AgentSession): Promise<void> {
  if (descriptor.kind === 'pi') {
    if (!session?.compact) throw new Error('This PI session does not expose native compaction.');
    await session.compact();
    return;
  }
  if (descriptor.kind === 'codex') return compactCodex(descriptor);
  return compactClaude(descriptor);
}
