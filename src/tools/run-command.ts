import { execSync } from 'child_process';
import { resolve } from 'path';
import type { ToolDefinition } from './registry.js';

const MAX_OUTPUT = 10_000;

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
    const cwd = args.cwd ? resolve(defaultCwd, args.cwd as string) : defaultCwd;
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
      if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
        const e = err as { stdout: string; stderr: string; status: number };
        const output = `${e.stdout}\n${e.stderr}`.trim();
        const truncated = output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT) + `\n... [truncated]`
          : output;
        return `Command exited with code ${e.status}:\n${truncated}`;
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
