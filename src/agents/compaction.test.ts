import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { compactCodex } from './compaction.js';
import type { AgentDescriptor } from './types.js';

describe('native agent compaction', () => {
  it('initializes Codex app-server, resumes the same thread, and waits for compaction', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const requests: Array<Record<string, unknown>> = [];
    let buffered = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        if (typeof request.id !== 'number') continue;
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        if (request.method === 'thread/compact/start') {
          stdout.write(`${JSON.stringify({ method: 'thread/compacted', params: { threadId: 'thread-1' } })}\n`);
        }
      }
    });
    let killed = false;
    const child = { stdin, stdout, stderr, kill: () => { killed = true; return true; } } as unknown as ChildProcessWithoutNullStreams;
    const spawnChild = (() => child) as unknown as typeof spawn;
    const descriptor: AgentDescriptor = {
      id: 'codex', kind: 'codex', label: 'Codex', transport: 'local', cwd: '/repo', sessionId: 'thread-1',
      model: 'gpt-test', sandbox: 'read-only', approvalPolicy: 'never',
    };

    await compactCodex(descriptor, spawnChild);

    expect(requests.map((request) => request.method)).toEqual([
      'initialize', 'initialized', 'thread/resume', 'thread/compact/start',
    ]);
    expect(requests.find((request) => request.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-1', cwd: '/repo', model: 'gpt-test', sandbox: 'read-only', approvalPolicy: 'never',
    });
    expect(killed).toBe(true);
  });
});
