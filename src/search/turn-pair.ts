import { chunkId } from './id.js';
import type { Message } from '../types.js';
import type { TurnPair } from './types.js';

export function messagesToTurnPairs(messages: Message[], conversationId: string, source: string): TurnPair[] {
  const pairs: TurnPair[] = [];
  let i = 0;

  while (i < messages.length && messages[i]!.role !== 'user') i++;

  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role !== 'user') { i++; continue; }

    const userMsg = msg;
    i++;

    const assistantTexts: string[] = [];
    const toolParts: string[] = [];
    const participantIds = new Set<string>();
    if (userMsg.participantId) participantIds.add(userMsg.participantId);
    let lastAssistantId = '';

    while (i < messages.length && messages[i]!.role !== 'user') {
      const m = messages[i]!;
      if (m.role === 'assistant') {
        assistantTexts.push(m.content);
        lastAssistantId = m.id;
        if (m.participantId) participantIds.add(m.participantId);
      } else if (m.role === 'tool') {
        const snippet = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
        toolParts.push(`${m.toolName} -> ${snippet}`);
      }
      i++;
    }

    if (assistantTexts.length === 0) continue;

    pairs.push({
      id: chunkId(source, userMsg.id, lastAssistantId),
      source,
      conversationId,
      timestamp: new Date().toISOString(),
      userText: userMsg.content,
      assistantText: assistantTexts.join('\n'),
      toolSummary: toolParts.length > 0 ? toolParts.join('\n') : undefined,
      participantIds: participantIds.size > 0 ? [...participantIds] : undefined,
    });
  }

  return pairs;
}
