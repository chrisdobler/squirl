import { describe, expect, it } from 'vitest';
import { runCommandTool } from './run-command.js';

describe('run_command output normalization', () => {
  it('rejects empty commands and invalid working directories without nullish output', async () => {
    await expect(runCommandTool.execute({ command: '' }, process.cwd(), {})).resolves.toBe('Error: command must be a non-empty string.');
    const result = await runCommandTool.execute({ command: 'pwd', cwd: 'definitely-missing' }, process.cwd(), {});
    expect(result).toBe('Error: working directory does not exist or is not a directory.');
    expect(result).not.toMatch(/null|undefined/);
  });

  it('retains useful command failure output without nullish placeholders', async () => {
    const result = await runCommandTool.execute({ command: "sh -c 'echo useful-error >&2; exit 7'" }, process.cwd(), {});
    expect(result).toContain('Command exited with code 7');
    expect(result).toContain('useful-error');
    expect(result).not.toMatch(/null|undefined/);
  });
});
