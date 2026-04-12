import { readFileSync } from 'node:fs';
import { messagesToTurnPairs } from '../turn-pair.js';
import type { TurnPair, Importer } from '../types.js';
import type { Message } from '../../types.js';

interface ChatGPTMapping {
  [nodeId: string]: {
    id: string;
    message: { author: { role: string }; content: { parts: string[] } } | null;
    parent: string | null;
    children: string[];
  };
}

interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number;
  mapping: ChatGPTMapping;
}

function linearize(mapping: ChatGPTMapping): Message[] {
  const messages: Message[] = [];
  let nodeId = Object.keys(mapping).find((k) => !mapping[k]!.parent || !mapping[mapping[k]!.parent!]);
  if (!nodeId) return messages;

  while (nodeId) {
    const node = mapping[nodeId]!;
    if (node.message && node.message.author.role !== 'system') {
      const role = node.message.author.role as 'user' | 'assistant';
      const content = node.message.content.parts.join('\n');
      if (role === 'user' || role === 'assistant') {
        messages.push({ id: node.id, role, content } as Message);
      }
    }
    if (node.children.length === 0) break;
    nodeId = node.children[node.children.length - 1]!;
  }

  return messages;
}

export class ChatGPTImporter implements Importer {
  name = 'chatgpt';

  async *parseConversations(conversations: ChatGPTConversation[]): AsyncIterable<TurnPair> {
    for (const conv of conversations) {
      const messages = linearize(conv.mapping);
      yield* messagesToTurnPairs(messages, `chatgpt:${conv.id}`, 'chatgpt');
    }
  }

  async *parse(path: string): AsyncIterable<TurnPair> {
    const raw = readFileSync(path, 'utf-8');
    const conversations = JSON.parse(raw) as ChatGPTConversation[];
    yield* this.parseConversations(conversations);
  }
}
