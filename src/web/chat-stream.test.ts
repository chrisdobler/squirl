import { describe, expect, it, vi } from 'vitest';
import { consumeChatEventStream, runRecoverableChatStream } from './chat-stream.js';
import type { ChatEvent } from './types.js';

const encoder = new TextEncoder();

function streamedResponse(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}

describe('consumeChatEventStream', () => {
  it('parses events split across arbitrary chunks and a final line without a newline', async () => {
    const events: ChatEvent[] = [];
    await consumeChatEventStream(streamedResponse([
      '{"type":"status","status":{"isStreaming":true,',
      '"pipelineStatus":{"stage":"memory-query"}}}\n{"type":"do',
      'ne"}',
    ]), (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual(['status', 'done']);
  });

  it('rejects non-success responses and missing bodies', async () => {
    await expect(consumeChatEventStream(new Response('{"error":"offline"}', {
      status: 503,
      statusText: 'Unavailable',
      headers: { 'Content-Type': 'application/json' },
    }), () => {})).rejects.toThrow('Chat request failed (503 Unavailable): offline');
    await expect(consumeChatEventStream(new Response(null, { status: 200 }), () => {})).rejects.toThrow('no body');
  });

  it('rejects malformed event JSON', async () => {
    await expect(consumeChatEventStream(streamedResponse(['{"type": nope}\n']), () => {})).rejects.toThrow('malformed JSON');
  });

  it('rejects an abrupt reader failure', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"status"}\n'));
        controller.error(new Error('socket closed'));
      },
    }));
    await expect(consumeChatEventStream(response, () => {})).rejects.toThrow('socket closed');
  });
});

describe('runRecoverableChatStream', () => {
  it('settles and reconciles after a normal stream', async () => {
    const order: string[] = [];
    await runRecoverableChatStream({
      request: async () => streamedResponse(['{"type":"done"}\n']),
      onEvent: (event) => order.push(event.type),
      onTransportError: () => order.push('error'),
      onSettled: () => order.push('settled'),
      reconcile: async () => { order.push('reconciled'); },
    });
    expect(order).toEqual(['done', 'settled', 'reconciled']);
  });

  it('delivers backend errors without misreporting a transport failure', async () => {
    const events: ChatEvent[] = [];
    const onTransportError = vi.fn();
    await runRecoverableChatStream({
      request: async () => streamedResponse(['{"type":"error","message":"Model request timed out."}\n{"type":"done"}\n']),
      onEvent: (event) => events.push(event),
      onTransportError,
      onSettled: () => {},
      reconcile: async () => {},
    });
    expect(events).toEqual([
      { type: 'error', message: 'Model request timed out.' },
      { type: 'done' },
    ]);
    expect(onTransportError).not.toHaveBeenCalled();
  });

  it('reports a disconnect once, settles locally, and tolerates reconciliation failure', async () => {
    const onTransportError = vi.fn();
    const onSettled = vi.fn();
    await expect(runRecoverableChatStream({
      request: async () => { throw new Error('connection reset'); },
      onEvent: () => {},
      onTransportError,
      onSettled,
      reconcile: async () => { throw new Error('API restarting'); },
    })).resolves.toBeUndefined();
    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(onTransportError.mock.calls[0]?.[0].message).toBe('connection reset');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
