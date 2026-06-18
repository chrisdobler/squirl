// In-memory transport test double. Captures stdin writes and the spawn argv, and lets a test
// drive stdout line-by-line (typically replaying a captured fixture). No real subprocess.

import type { AgentTransport, SpawnHandle, SpawnSpec } from '../types.js';

export class FakeSpawnHandle implements SpawnHandle {
  /** Everything written to stdin, concatenated. */
  stdinData = '';
  /** Each individual write, in order. */
  writes: string[] = [];
  stdinEnded = false;
  killed = false;
  killSignal: NodeJS.Signals | null = null;

  private stdoutHandlers: Array<(line: string) => void> = [];
  private stderrHandlers: Array<(line: string) => void> = [];
  private resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;

  exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    this.resolveExit = resolve;
  });

  stdin = {
    write: (chunk: string) => {
      this.stdinData += chunk;
      this.writes.push(String(chunk));
      return true;
    },
    end: () => { this.stdinEnded = true; },
  } as unknown as NodeJS.WritableStream;

  onStdout(handler: (line: string) => void): void { this.stdoutHandlers.push(handler); }
  onStderr(handler: (line: string) => void): void { this.stderrHandlers.push(handler); }
  kill(signal?: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal ?? null;
    this.resolveExit({ code: null, signal: signal ?? 'SIGTERM' });
  }

  // ---- test helpers ----
  emitStdout(line: string): void { this.stdoutHandlers.forEach((h) => h(line)); }
  emitStdoutLines(lines: string[]): void { lines.forEach((l) => this.emitStdout(l)); }
  emitStderr(line: string): void { this.stderrHandlers.forEach((h) => h(line)); }
  close(code = 0): void { this.resolveExit({ code, signal: null }); }
}

export class FakeTransport implements AgentTransport {
  readonly kind = 'local' as const;
  spawns: Array<{ spec: SpawnSpec; handle: FakeSpawnHandle }> = [];

  async spawn(spec: SpawnSpec): Promise<SpawnHandle> {
    const handle = new FakeSpawnHandle();
    this.spawns.push({ spec, handle });
    return handle;
  }

  get lastSpawn(): { spec: SpawnSpec; handle: FakeSpawnHandle } {
    return this.spawns[this.spawns.length - 1]!;
  }
}
