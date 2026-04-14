import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    const node: ChatGPTMapping[string] = mapping[nodeId]!;
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
      const timestamp = new Date(conv.create_time * 1000).toISOString();
      const pairs = messagesToTurnPairs(messages, `chatgpt:${conv.id}`, 'chatgpt');
      for (const pair of pairs) {
        yield { ...pair, timestamp };
      }
    }
  }

  private findConversationFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        files.push(...this.findConversationFiles(join(dir, entry.name)));
      } else if (entry.name.endsWith('.json') && /conversations/i.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
    return files.sort();
  }

  async *parse(path: string): AsyncIterable<TurnPair> {
    const resolved = path.replace(/\\ /g, ' ');
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const files = this.findConversationFiles(resolved);
      if (files.length === 0) throw new Error(`No conversation files found in ${resolved}`);
      for (const file of files) {
        const raw = readFileSync(file, 'utf-8');
        const conversations = JSON.parse(raw) as ChatGPTConversation[];
        yield* this.parseConversations(conversations);
      }
    } else {
      const raw = readFileSync(resolved, 'utf-8');
      const conversations = JSON.parse(raw) as ChatGPTConversation[];
      yield* this.parseConversations(conversations);
    }
  }
}
