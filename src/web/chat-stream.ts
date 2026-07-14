import type { ChatEvent } from './types.js';

export interface RecoverableChatStreamOptions {
  request: () => Promise<Response>;
  onEvent: (event: ChatEvent) => void;
  onTransportError: (error: Error) => void;
  onSettled: () => void;
  reconcile: () => Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  const detail = typeof body.error === 'string' && body.error.trim() ? `: ${body.error}` : '';
  return new Error(`Chat request failed (${response.status} ${response.statusText})${detail}`);
}

function parseEvent(line: string): ChatEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Chat stream returned malformed JSON.');
  }
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') {
    throw new Error('Chat stream returned an invalid event.');
  }
  return value as ChatEvent;
}

export async function consumeChatEventStream(response: Response, onEvent: (event: ChatEvent) => void): Promise<void> {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Chat stream response had no body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onEvent(parseEvent(line));
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) onEvent(parseEvent(buffer));
}

export async function runRecoverableChatStream(options: RecoverableChatStreamOptions): Promise<void> {
  try {
    await consumeChatEventStream(await options.request(), options.onEvent);
  } catch (error) {
    options.onTransportError(asError(error));
  } finally {
    options.onSettled();
    try {
      await options.reconcile();
    } catch {
      // The API may still be restarting. The renderer resumes background polling
      // after onSettled, which will reconcile authoritative state when it returns.
    }
  }
}
