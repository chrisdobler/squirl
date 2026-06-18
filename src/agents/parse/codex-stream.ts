// Parser for `codex exec --json` JSONL output. Codex emits whole messages (no token
// deltas), one process per turn. The thread id from `thread.started` is the resume handle.
//
// Observed event shapes (see __fixtures__/codex-*.jsonl):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id","type":"command_execution","command","status":"in_progress"}}
//   {"type":"item.completed","item":{"id","type":"command_execution","command","aggregated_output","exit_code","status":"completed"}}
//   {"type":"item.completed","item":{"id","type":"agent_message","text"}}
//   {"type":"turn.completed","usage":{"input_tokens","output_tokens",...}}

import type { AgentEvent, ParserOptions, StreamParser } from '../types.js';

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

export function createCodexParser(opts: ParserOptions): StreamParser {
  const { participantId, newMessageId } = opts;

  function parseObject(obj: Record<string, unknown>): AgentEvent[] {
    switch (obj.type) {
      case 'thread.started':
        return [{ type: 'session-status', participantId, status: 'ready', sessionId: String(obj.thread_id ?? '') }];

      case 'item.started': {
        const item = (obj.item ?? {}) as CodexItem;
        if (item.type === 'agent_message') return [];
        return [{
          type: 'tool-start',
          participantId,
          toolId: String(item.id ?? ''),
          toolName: String(item.type ?? 'tool'),
          input: item.command !== undefined ? { command: item.command } : item,
        }];
      }

      case 'item.completed': {
        const item = (obj.item ?? {}) as CodexItem;
        if (item.type === 'agent_message') {
          const messageId = newMessageId();
          const text = String(item.text ?? '');
          return [
            { type: 'message-start', participantId, messageId },
            { type: 'token', participantId, messageId, token: text },
            { type: 'message-end', participantId, messageId, content: text },
          ];
        }
        return [{
          type: 'tool-end',
          participantId,
          toolId: String(item.id ?? ''),
          toolName: String(item.type ?? 'tool'),
          result: String(item.aggregated_output ?? ''),
          ok: item.exit_code != null ? item.exit_code === 0 : item.status === 'completed',
        }];
      }

      case 'turn.completed': {
        const usage = (obj.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        return [
          { type: 'usage', participantId, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } },
          { type: 'turn-end', participantId },
        ];
      }

      case 'turn.failed':
      case 'error': {
        const message = typeof obj.message === 'string' ? obj.message : 'codex turn failed';
        return [{ type: 'error', participantId, message }];
      }

      default:
        return [];
    }
  }

  return {
    push(line: string): AgentEvent[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return []; // Codex prints non-JSON status lines (e.g. "Reading additional input...") to stdout.
      }
      return parseObject(obj);
    },

    end(code: number | null): AgentEvent[] {
      if (code != null && code !== 0) {
        return [
          { type: 'error', participantId, message: `codex exited with code ${code}` },
          { type: 'exit', participantId, code },
        ];
      }
      return [];
    },
  };
}
