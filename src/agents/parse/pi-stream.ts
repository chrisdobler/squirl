// Parser for `pi --mode rpc`. PI uses strict LF-delimited JSONL over stdin/stdout.
// A Squirl turn completes only after PI reports `agent_settled` and the adapter asks
// for authoritative session statistics.

import type { AgentEvent, AgentInteractionRequest, ParserOptions, StreamParser } from '../types.js';

interface PiParserOptions extends ParserOptions {
  onSettled: () => void;
  onUnsupportedInteraction?: (id: string) => void;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((item) => {
    if (typeof item === 'string') return item;
    const block = record(item);
    return typeof block.text === 'string' ? block.text : JSON.stringify(item);
  }).join('');
}

function assistantText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value.map((item) => {
    const block = record(item);
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).join('');
}

function modelId(value: unknown): string | undefined {
  const model = record(value);
  const id = typeof model.id === 'string' ? model.id : typeof model.model === 'string' ? model.model : undefined;
  const provider = typeof model.provider === 'string' ? model.provider : undefined;
  if (!id) return undefined;
  return provider && !id.includes('/') ? `${provider}/${id}` : id;
}

export function createPiParser(opts: PiParserOptions): StreamParser {
  const { participantId, newMessageId } = opts;
  let messageId: string | null = null;
  let messageText = '';
  let currentModel = '';
  let pendingError = '';

  function ensureMessage(out: AgentEvent[]): string {
    if (!messageId) {
      messageId = newMessageId();
      messageText = '';
      out.push({
        type: 'message-start', participantId, messageId,
        ...(currentModel ? { responseMeta: { model: currentModel } } : {}),
      });
    }
    return messageId;
  }

  function closeMessage(out: AgentEvent[]): void {
    if (!messageId) return;
    out.push({ type: 'message-end', participantId, messageId, content: messageText });
    messageId = null;
    messageText = '';
  }

  function interaction(obj: Record<string, unknown>): AgentInteractionRequest | null {
    const id = typeof obj.id === 'string' ? obj.id : '';
    const method = obj.method;
    if (!id || !['select', 'confirm', 'input', 'editor'].includes(String(method))) return null;
    const common = {
      id,
      title: typeof obj.title === 'string' ? obj.title : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
    };
    const permissionEnvelope = [common.title, common.message].find((value) => value?.startsWith('SQUIRL_PERMISSION:'));
    if (method === 'select' && permissionEnvelope) {
      try {
        const metadata = JSON.parse(permissionEnvelope.slice('SQUIRL_PERMISSION:'.length)) as {
          toolName?: string; input?: unknown; resource?: string; sessionScope?: { key: string; label: string };
        };
        if (metadata.toolName) return {
          id, method: 'permission', title: `PI wants to use ${metadata.toolName}`,
          toolName: metadata.toolName, input: metadata.input, resource: metadata.resource,
          sessionScope: metadata.sessionScope,
        };
      } catch { /* Fall through to the ordinary select UI. */ }
    }
    if (method === 'select') {
      return { ...common, method, options: Array.isArray(obj.options) ? obj.options.filter((item): item is string => typeof item === 'string') : [] };
    }
    if (method === 'confirm') return { ...common, method };
    if (method === 'input') return { ...common, method, placeholder: typeof obj.placeholder === 'string' ? obj.placeholder : undefined };
    return { ...common, method: 'editor', prefill: typeof obj.prefill === 'string' ? obj.prefill : undefined };
  }

  return {
    push(line: string): AgentEvent[] {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line.trim()) as Record<string, unknown>; }
      catch { return []; }
      const out: AgentEvent[] = [];

      if (obj.type === 'message_update') {
        const delta = record(obj.assistantMessageEvent);
        if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
          const id = ensureMessage(out);
          messageText += delta.delta;
          out.push({ type: 'token', participantId, messageId: id, token: delta.delta });
        } else if (delta.type === 'error') {
          pendingError = typeof delta.error === 'string' ? delta.error : typeof delta.message === 'string' ? delta.message : 'PI agent failed';
        }
        return out;
      }

      if (obj.type === 'message_end') {
        const message = record(obj.message);
        if (message.role === 'assistant') {
          const full = assistantText(message.content);
          const suffix = full.startsWith(messageText) ? full.slice(messageText.length) : full;
          if (suffix) {
            const id = ensureMessage(out);
            messageText += suffix;
            out.push({ type: 'token', participantId, messageId: id, token: suffix });
          }
        }
        return out;
      }

      if (obj.type === 'tool_execution_start') {
        closeMessage(out);
        out.push({
          type: 'tool-start', participantId,
          toolId: typeof obj.toolCallId === 'string' ? obj.toolCallId : '',
          toolName: typeof obj.toolName === 'string' ? obj.toolName : 'tool',
          input: obj.args ?? {},
        });
        return out;
      }

      if (obj.type === 'tool_execution_end') {
        out.push({
          type: 'tool-end', participantId,
          toolId: typeof obj.toolCallId === 'string' ? obj.toolCallId : '',
          toolName: typeof obj.toolName === 'string' ? obj.toolName : 'tool',
          result: textContent(record(obj.result).content ?? obj.result),
          ok: obj.isError !== true,
        });
        return out;
      }

      if (obj.type === 'auto_retry_end') {
        if (obj.success === true) pendingError = '';
        else if (obj.success === false) pendingError = typeof obj.finalError === 'string' ? obj.finalError : 'PI agent exhausted its retries';
        return out;
      }

      if (obj.type === 'agent_settled') {
        closeMessage(out);
        opts.onSettled();
        return out;
      }

      if (obj.type === 'extension_error') {
        out.push({ type: 'interaction-notify', participantId, level: 'error', message: typeof obj.error === 'string' ? obj.error : 'PI extension failed' });
        return out;
      }

      if (obj.type === 'extension_ui_request') {
        const request = interaction(obj);
        if (request) out.push({ type: 'interaction-request', participantId, request });
        else if (obj.method === 'notify') {
          out.push({
            type: 'interaction-notify', participantId,
            message: typeof obj.message === 'string' ? obj.message : '',
            level: obj.notifyType === 'error' ? 'error' : obj.notifyType === 'warning' ? 'warning' : 'info',
          });
        } else if (obj.method === 'setStatus') {
          out.push({ type: 'interaction-status', participantId, key: typeof obj.statusKey === 'string' ? obj.statusKey : 'pi', text: typeof obj.statusText === 'string' ? obj.statusText : undefined });
        } else if (obj.method === 'set_editor_text' && typeof obj.text === 'string') {
          out.push({ type: 'interaction-editor-prefill', participantId, text: obj.text });
        } else if (typeof obj.id === 'string' && ['select', 'confirm', 'input', 'editor'].includes(String(obj.method))) {
          opts.onUnsupportedInteraction?.(obj.id);
        }
        return out;
      }

      if (obj.type === 'response') {
        const command = obj.command;
        const data = record(obj.data);
        if (command === 'get_state') {
          if (obj.success !== true) {
            out.push({ type: 'error', participantId, message: typeof obj.error === 'string' ? obj.error : 'PI RPC startup failed' });
            return out;
          }
          currentModel = modelId(data.model) ?? currentModel;
          out.push({
            type: 'session-status', participantId, status: 'ready',
            ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
            ...(currentModel ? { model: currentModel } : {}),
          });
          return out;
        }
        if (command === 'get_session_stats') {
          const tokens = record(data.tokens);
          const context = record(data.contextUsage);
          if (obj.success === true) {
            out.push({
              type: 'usage', participantId,
              usage: {
                inputTokens: typeof context.tokens === 'number' ? context.tokens : typeof tokens.input === 'number' ? tokens.input : undefined,
                cachedInputTokens: typeof tokens.cacheRead === 'number' ? tokens.cacheRead : undefined,
                cacheCreationInputTokens: typeof tokens.cacheWrite === 'number' ? tokens.cacheWrite : undefined,
                outputTokens: typeof tokens.output === 'number' ? tokens.output : undefined,
                costUsd: typeof data.cost === 'number' ? data.cost : undefined,
                contextWindow: typeof context.contextWindow === 'number' ? context.contextWindow : undefined,
              },
            });
          }
          if (pendingError) out.push({ type: 'error', participantId, message: pendingError });
          pendingError = '';
          out.push({ type: 'turn-end', participantId });
          return out;
        }
        if (command === 'prompt' && obj.success === false) {
          out.push({ type: 'error', participantId, message: typeof obj.error === 'string' ? obj.error : 'PI rejected the prompt' });
          out.push({ type: 'turn-end', participantId });
        }
      }
      return out;
    },

    end(code: number | null): AgentEvent[] {
      const out: AgentEvent[] = [];
      closeMessage(out);
      if (code && code !== 0) out.push({ type: 'error', participantId, message: `PI exited with code ${code}` });
      return out;
    },
  };
}
