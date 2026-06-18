// Local subprocess transport. The only thing it does: given an argv, spawn a process and
// hand back line-buffered stdio. This is the seam where an SshTransport later drops in
// (build `ssh user@host -- <command>` and reuse the same line splitting).
//
// Precedent: src/api.ts already spawns `curl` and parses streaming stdout line-by-line.

import { spawn } from 'node:child_process';
import type { AgentTransport, SpawnHandle, SpawnSpec } from '../types.js';

/** Splits a byte stream into newline-delimited lines, buffering partial trailing data. */
function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  };
}

export class LocalSpawnTransport implements AgentTransport {
  readonly kind = 'local' as const;

  async spawn(spec: SpawnSpec): Promise<SpawnHandle> {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutHandlers: Array<(line: string) => void> = [];
    const stderrHandlers: Array<(line: string) => void> = [];
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', createLineSplitter((line) => stdoutHandlers.forEach((h) => h(line))));
    child.stderr?.on('data', createLineSplitter((line) => stderrHandlers.forEach((h) => h(line))));

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      child.on('error', () => resolve({ code: null, signal: null }));
    });

    return {
      stdin: child.stdin!,
      onStdout: (handler) => { stdoutHandlers.push(handler); },
      onStderr: (handler) => { stderrHandlers.push(handler); },
      exited,
      kill: (signal) => child.kill(signal),
    };
  }
}
