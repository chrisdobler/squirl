// Parser for `claude --print --output-format stream-json --verbose` output.
//
// The adapter always runs with --include-partial-messages so text streams as
// content_block_delta tokens. The parser also handles the non-partial case (text only in
// the top-level `assistant` snapshot) by tracking, per Claude message id, how much text was
// already streamed via deltas — so the snapshot never double-emits text.
//
// A turn can produce several `assistant` messages (thinking, tool_use, text). We segment the
// narrative into squirl messages: text accumulates into one message that is closed whenever a
// tool call starts or the turn ends. tool_use/tool_result surface as separate tool events.
//
// System hook/status/thinking_tokens lines are noise and skipped. `--bare` is NOT used by
// default because it disables OAuth/keychain auth (requires ANTHROPIC_API_KEY).

import type { AgentEvent, ParserOptions, StreamParser } from '../types.js';

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c as ContentBlock).text ?? JSON.stringify(c))).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function createClaudeParser(opts: ParserOptions): StreamParser {
  const { participantId, newMessageId } = opts;

  let currentClaudeMsgId = '';
  let currentModel = '';
  const deltaTextByMsgId = new Map<string, string>();
  const toolNameById = new Map<string, string>();

  // Open narrative message (the squirl-facing assistant bubble for streamed text).
  let messageId: string | null = null;
  let messageText = '';

  function ensureMessage(out: AgentEvent[]): string {
    if (messageId == null) {
      messageId = newMessageId();
      messageText = '';
      out.push({ type: 'message-start', participantId, messageId, ...(currentModel ? { responseMeta: { model: currentModel } } : {}) });
    }
    return messageId;
  }

  function closeMessage(out: AgentEvent[]): void {
    if (messageId != null) {
      out.push({ type: 'message-end', participantId, messageId, content: messageText });
      messageId = null;
      messageText = '';
    }
  }

  function emitText(text: string, out: AgentEvent[]): void {
    if (!text) return;
    const id = ensureMessage(out);
    messageText += text;
    out.push({ type: 'token', participantId, messageId: id, token: text });
  }

  function handleStreamEvent(event: Record<string, unknown>, out: AgentEvent[]): void {
    const t = event.type;
    if (t === 'message_start') {
      const msg = (event.message ?? {}) as { id?: string; model?: string };
      if (msg.id) currentClaudeMsgId = msg.id;
      if (msg.model) currentModel = msg.model;
      return;
    }
    if (t === 'content_block_delta') {
      const delta = (event.delta ?? {}) as { type?: string; text?: string };
      if (delta.type === 'text_delta' && delta.text) {
        deltaTextByMsgId.set(currentClaudeMsgId, (deltaTextByMsgId.get(currentClaudeMsgId) ?? '') + delta.text);
        emitText(delta.text, out);
      }
    }
    // content_block_start/stop, message_delta, message_stop carry no extra content for us.
  }

  function handleAssistant(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const message = (obj.message ?? {}) as { id?: string; model?: string; content?: ContentBlock[] };
    if (message.id) currentClaudeMsgId = message.id;
    if (message.model) currentModel = message.model;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const full = block.text ?? '';
        const already = deltaTextByMsgId.get(currentClaudeMsgId) ?? '';
        const suffix = full.startsWith(already) ? full.slice(already.length) : full;
        if (suffix) emitText(suffix, out);
        deltaTextByMsgId.set(currentClaudeMsgId, full);
      } else if (block.type === 'tool_use') {
        closeMessage(out); // end the narrative bubble before showing tool activity
        const toolId = block.id ?? '';
        const toolName = block.name ?? 'tool';
        toolNameById.set(toolId, toolName);
        out.push({ type: 'tool-start', participantId, toolId, toolName, input: block.input ?? {} });
      }
      // thinking blocks are intentionally not surfaced as content.
    }
  }

  function handleUser(obj: Record<string, unknown>, out: AgentEvent[]): void {
    const message = (obj.message ?? {}) as { content?: ContentBlock[] };
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const toolId = block.tool_use_id ?? '';
        out.push({
          type: 'tool-end',
          participantId,
          toolId,
          toolName: toolNameById.get(toolId) ?? 'tool',
          result: stringifyToolResult(block.content),
          ok: !block.is_error,
        });
      }
    }
  }

  function handleResult(obj: Record<string, unknown>, out: AgentEvent[]): void {
    if (obj.is_error) {
      closeMessage(out);
      out.push({ type: 'error', participantId, message: typeof obj.result === 'string' ? obj.result : 'claude error' });
      out.push({ type: 'turn-end', participantId });
      return;
    }
    closeMessage(out);
    const usage = (obj.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    out.push({
      type: 'usage',
      participantId,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined },
    });
    out.push({ type: 'turn-end', participantId });
  }

  return {
    push(line: string): AgentEvent[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return [];
      }

      const out: AgentEvent[] = [];
      switch (obj.type) {
        case 'system':
          if (obj.subtype === 'init') {
            currentModel = typeof obj.model === 'string' ? obj.model : currentModel;
            out.push({
              type: 'session-status',
              participantId,
              status: 'ready',
              sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
              model: typeof obj.model === 'string' ? obj.model : undefined,
            });
          }
          // hook_started / hook_response / status / thinking_tokens: noise, skip.
          break;
        case 'stream_event':
          handleStreamEvent((obj.event ?? {}) as Record<string, unknown>, out);
          break;
        case 'assistant':
          handleAssistant(obj, out);
          break;
        case 'user':
          handleUser(obj, out);
          break;
        case 'result':
          handleResult(obj, out);
          break;
        // rate_limit_event and anything unknown: skip.
      }
      return out;
    },

    end(code: number | null): AgentEvent[] {
      const out: AgentEvent[] = [];
      closeMessage(out);
      if (code != null && code !== 0) {
        out.push({ type: 'error', participantId, message: `claude exited with code ${code}` });
        out.push({ type: 'exit', participantId, code });
      }
      return out;
    },
  };
}
