import { execSync } from 'child_process';
import { resolve } from 'path';
import { statSync } from 'fs';
import type { ToolDefinition } from './registry.js';

const MAX_OUTPUT = 10_000;

const BLOCKED_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bfetch\b/i,
  /\bnc\b/,
  /\bncat\b/i,
  /\bhttp\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bsftp\b/i,
  /\btelnet\b/i,
  /\bopen\s+https?:/i,
  /\bnpm\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\bgit\s+push\b/i,
];

export function isNetworkCommand(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

export const runCommandTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command and return its output (stdout + stderr).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory for the command (optional, defaults to project root)' },
        },
        required: ['command'],
      },
    },
  },
  execute: async (args, defaultCwd) => {
    if (typeof args.command !== 'string' || !args.command.trim()) return 'Error: command must be a non-empty string.';
    if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd.trim())) return 'Error: working directory must be a non-empty string.';
    const cwd = typeof args.cwd === 'string' ? resolve(defaultCwd, args.cwd) : defaultCwd;
    try {
      if (!statSync(cwd).isDirectory()) return 'Error: working directory does not exist or is not a directory.';
    } catch {
      return 'Error: working directory does not exist or is not a directory.';
    }
    try {
      const output = execSync(args.command as string, {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const trimmed = output.trim();
      if (trimmed.length > MAX_OUTPUT) {
        return trimmed.slice(0, MAX_OUTPUT) + `\n... [output truncated at ${MAX_OUTPUT} chars]`;
      }
      return trimmed || '(no output)';
    } catch (err: unknown) {
      if (err && typeof err === 'object') {
        const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number | null; signal?: string };
        const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? '';
        const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
        const output = `${stdout}\n${stderr}`.trim() || (err instanceof Error ? err.message : '');
        const truncated = output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT) + `\n... [truncated]`
          : output;
        const outcome = typeof e.status === 'number' ? `exited with code ${e.status}`
          : e.signal ? `stopped by signal ${e.signal}` : 'failed to start';
        return `Command ${outcome}${truncated ? `:\n${truncated}` : '.'}`;
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
