import { describe, expect, it } from 'vitest';
import { getToolDefinitions, validateToolCall } from './registry.js';

describe('native workspace tool gating', () => {
  it('offers only the workspace tools authorized for the turn', () => {
    expect(getToolDefinitions({ allowedWorkspaceTools: [] })).toEqual([]);
    expect(getToolDefinitions({ allowedWorkspaceTools: ['read_file', 'list_files'] }).map((tool) => tool.function.name))
      .toEqual(['read_file', 'list_files']);
  });

  it('rejects unoffered and malformed calls before execution', () => {
    expect(validateToolCall('run_command', '{"command":"pwd"}', [], process.cwd())).toMatchObject({ ok: false, reason: 'not-allowed' });
    expect(validateToolCall('run_command', '{bad', ['run_command'], process.cwd())).toMatchObject({ ok: false, reason: 'malformed-arguments' });
    expect(validateToolCall('run_command', '{}', ['run_command'], process.cwd())).toMatchObject({ ok: false, reason: 'invalid-arguments' });
  });

  it('rejects a missing working directory and accepts a valid command', () => {
    expect(validateToolCall('run_command', '{"command":"pwd","cwd":"definitely-missing"}', ['run_command'], process.cwd()))
      .toMatchObject({ ok: false, reason: 'invalid-cwd' });
    expect(validateToolCall('run_command', '{"command":"pwd","cwd":"."}', ['run_command'], process.cwd()))
      .toEqual({ ok: true, args: { command: 'pwd', cwd: '.' } });
  });
});
