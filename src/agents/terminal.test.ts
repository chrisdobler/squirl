import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as pty from 'node-pty';

import type { AgentDescriptor } from './types.js';
import { AgentTerminalManager, importTerminalTranscript, interactiveAgentArgs } from './terminal.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function descriptor(kind: AgentDescriptor['kind'], sessionId = 'session-1'): AgentDescriptor {
  return { id: kind, kind, label: kind, transport: 'local', cwd: '/repo', sessionId, model: 'model-1', effort: 'high' };
}

describe('agent terminal handoff', () => {
  it('builds native interactive resume commands without headless flags', () => {
    expect(interactiveAgentArgs({ ...descriptor('claude-code'), permissionMode: 'plan' })).toEqual(expect.arrayContaining(['--resume', 'session-1', '--permission-mode', 'plan']));
    expect(interactiveAgentArgs({ ...descriptor('codex'), sandbox: 'read-only', approvalPolicy: 'never' })).toEqual(expect.arrayContaining(['resume', 'session-1', '--sandbox', 'read-only', '--ask-for-approval', 'never']));
    expect(interactiveAgentArgs({ ...descriptor('pi'), piToolMode: 'read-only' })).toEqual(expect.arrayContaining(['--session-id', 'session-1', '--tools', 'read,grep,find,ls']));
    expect(interactiveAgentArgs(descriptor('claude-code'))).not.toContain('--print');
  });

  it('imports only appended PI user and assistant turns and ignores control commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'squirl-terminal-'));
    roots.push(root);
    const path = join(root, 'session.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'message', id: 'old', message: { role: 'user', content: [{ type: 'text', text: 'old turn' }] } })}\n`);
    const offset = statSync(path).size;
    appendFileSync(path, [
      { type: 'message', id: 'compact', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } },
      { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'new question' }] } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'new answer' }] } },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n');
    expect(importTerminalTranscript(descriptor('pi'), { path, offset })).toEqual([
      { id: 'terminal-pi-u1', role: 'user', content: 'new question', participantId: 'pi' },
      { id: 'terminal-pi-a1', role: 'assistant', content: 'new answer', participantId: 'pi' },
    ]);
  });

  it('authorizes PTY control, buffers output, resizes, and cleans up', async () => {
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    let dataHandler: (data: string) => void = () => undefined;
    let exitHandler: (event: { exitCode: number; signal?: number }) => void = () => undefined;
    const fake = {
      onData: (handler: typeof dataHandler) => { dataHandler = handler; return { dispose() {} }; },
      onExit: (handler: typeof exitHandler) => { exitHandler = handler; return { dispose() {} }; },
      write: (data: string) => { writes.push(data); },
      resize: (cols: number, rows: number) => { resizes.push([cols, rows]); },
      kill: () => undefined,
    } as unknown as pty.IPty;
    const output: string[] = [];
    const exits: number[] = [];
    const manager = new AgentTerminalManager(
      (_id, data) => output.push(data),
      (_id, code) => exits.push(code),
      (() => fake) as typeof pty.spawn,
    );
    const started = manager.start(descriptor('pi'), 90, 25);
    dataHandler('hello');
    expect(manager.start(descriptor('pi')).output).toBe('hello');
    expect(output).toEqual(['hello']);
    expect(() => manager.write('pi', 'wrong', 'x')).toThrow('Invalid terminal capability');
    manager.write('pi', started.capability, 'input');
    manager.resize('pi', started.capability, 120, 40);
    expect(writes).toContain('input');
    expect(resizes).toEqual([[120, 40]]);
    exitHandler({ exitCode: 7 });
    expect(exits).toEqual([7]);
    await manager.stop('pi', started.capability);
    expect(writes).toContain('\x03');
    expect(manager.get('pi')).toBeUndefined();
  });
});
