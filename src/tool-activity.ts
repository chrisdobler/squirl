import type { Message, ToolMessage } from './types.js';

export const TOOL_OUTPUT_LIMIT = 20_000;

export function boundedToolOutput(result: string): { content: string; truncated: boolean } {
  if (result.length <= TOOL_OUTPUT_LIMIT) return { content: result, truncated: false };
  return { content: `${result.slice(0, TOOL_OUTPUT_LIMIT)}\n… output truncated`, truncated: true };
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return undefined;
}

function cleanToolName(toolName: string): string {
  const bare = toolName.includes(':') ? toolName.slice(toolName.lastIndexOf(':') + 1) : toolName;
  return bare.replace(/^\//, '').replace(/^mcp__/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim() || 'Tool';
}

export function toolActivitySummary(message: Pick<ToolMessage, 'toolName' | 'toolInput'>): string {
  const input = record(message.toolInput);
  const name = cleanToolName(message.toolName);
  const normalized = name.toLowerCase();
  const path = firstString(input, ['file_path', 'path', 'filename']);
  const command = firstString(input, ['command', 'cmd']);
  const query = firstString(input, ['query', 'pattern']);
  const target = path ?? command ?? query;

  if (normalized === 'memory') return 'Memory Lookup';

  if (!target) return name;
  if (/read|open|view/.test(normalized)) return `Read ${target}`;
  if (/write|create/.test(normalized)) return `Write ${target}`;
  if (/edit|patch|update/.test(normalized)) return `Edit ${target}`;
  if (/command|shell|exec|bash|run/.test(normalized)) return `Run ${target}`;
  if (/search|find|grep/.test(normalized)) return `Search ${target}`;
  return `${name} ${target}`;
}

export interface MessageTurn {
  key: string;
  messages: Message[];
}

/** User messages stand alone; adjacent non-user messages from one participant form one turn. */
export function groupMessageTurns(messages: Message[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: message.id, messages: [message] });
      continue;
    }
    const participantId = message.participantId ?? 'squirl';
    const previous = turns[turns.length - 1];
    const previousParticipant = previous?.messages[0]?.role === 'user'
      ? null
      : previous?.messages[0]?.participantId ?? 'squirl';
    if (previous && previousParticipant === participantId) previous.messages.push(message);
    else turns.push({ key: message.id, messages: [message] });
  }
  return turns;
}
