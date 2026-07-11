import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_LIMIT, boundedToolOutput, groupMessageTurns, toolActivitySummary } from './tool-activity.js';

describe('tool activity helpers', () => {
  it('humanizes common structured tools', () => {
    expect(toolActivitySummary({ toolName: 'cc:Read', toolInput: { file_path: 'src/app.tsx' } })).toBe('Read src/app.tsx');
    expect(toolActivitySummary({ toolName: 'command_execution', toolInput: { command: 'pnpm test' } })).toBe('Run pnpm test');
    expect(toolActivitySummary({ toolName: 'write_file', toolInput: { path: 'notes.md' } })).toBe('Write notes.md');
  });

  it('falls back to a cleaned name without dumping unknown input', () => {
    expect(toolActivitySummary({ toolName: 'cc:mystery_tool', toolInput: { nested: { secret: true } } })).toBe('Mystery Tool');
  });

  it('bounds persisted tool output', () => {
    const result = boundedToolOutput('x'.repeat(TOOL_OUTPUT_LIMIT + 1));
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('output truncated');
  });

  it('groups adjacent activity and narrative from the same participant', () => {
    const turns = groupMessageTurns([
      { id: 'u', role: 'user', content: 'inspect' },
      { id: 'a1', role: 'assistant', content: 'looking', participantId: 'cc' },
      { id: 't', role: 'tool', toolCallId: '1', toolName: 'Read', content: 'data', participantId: 'cc' },
      { id: 'a2', role: 'assistant', content: 'done', participantId: 'cc' },
    ]);
    expect(turns.map((turn) => turn.messages.map((message) => message.id))).toEqual([['u'], ['a1', 't', 'a2']]);
  });
});
