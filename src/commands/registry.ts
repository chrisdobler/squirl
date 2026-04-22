import { buildSystemPrompt } from '../context/system-prompt.js';
import { getModelConfig } from '../model-config.js';
import { platform } from 'node:os';
import { recall } from '../search/recall.js';
import type { Embedder, VectorStore } from '../search/types.js';
import type { Orchestrator } from '../orchestrator.js';
import type { Message } from '../types.js';

export interface CommandContext {
  orchestrator: Orchestrator;
  messages: Message[];
  workingDir: string;
  modelId: string;
  setMessages: (fn: (prev: Message[]) => Message[]) => void;
  openContextPicker: () => void;
  openSetup?: () => void;
  embedder?: Embedder;
  vectorStore?: VectorStore;
  indexEnabled?: boolean;
  recallQuery?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  execute: (ctx: CommandContext) => void | Promise<void>;
}

const commands: SlashCommand[] = [
  {
    name: 'context',
    description: 'Manage files and context sent to the model',
    execute: (ctx) => ctx.openContextPicker(),
  },
  {
    name: 'system',
    description: 'Show the raw system prompt',
    execute: (ctx) => {
      const config = getModelConfig(ctx.modelId);
      const msg = buildSystemPrompt(
        {
          workingDir: ctx.workingDir,
          date: new Date().toISOString().slice(0, 10),
          modelId: ctx.modelId,
          platform: platform(),
          shell: process.env.SHELL ?? 'unknown',
        },
        config.systemPromptStyle,
      );
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      ctx.setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'tool' as const,
        toolCallId: 'system-prompt',
        toolName: '/system',
        content,
      }]);
    },
  },
  {
    name: 'recall',
    description: 'Search past conversations semantically',
    execute: async (ctx) => {
      if (!ctx.indexEnabled || !ctx.embedder || !ctx.vectorStore) {
        ctx.setMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'tool' as const,
          toolCallId: 'recall', toolName: '/recall',
          content: 'Index not enabled. Add index config to ~/.squirl/config.json and run docker compose up -d',
        }]);
        return;
      }
      if (!ctx.recallQuery) {
        ctx.setMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'tool' as const,
          toolCallId: 'recall', toolName: '/recall',
          content: 'Usage: /recall <query>',
        }]);
        return;
      }
      const results = await recall(ctx.recallQuery, ctx.embedder, ctx.vectorStore, 5);
      const formatted = results.length === 0
        ? 'No results found.'
        : results.map((r, i) =>
          `${i + 1}. [${r.turnPair.source}] ${r.turnPair.timestamp.slice(0, 10)} (score: ${r.score.toFixed(3)})\n   Q: ${r.turnPair.userText.slice(0, 100)}\n   A: ${r.turnPair.assistantText.slice(0, 200)}`
        ).join('\n\n');
      ctx.setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'tool' as const,
        toolCallId: 'recall', toolName: '/recall',
        content: formatted,
      }]);
    },
  },
  {
    name: 'setup',
    description: 'Re-run onboarding to change provider, keys, or index settings',
    execute: (ctx) => {
      if (ctx.openSetup) ctx.openSetup();
    },
  },
  {
    name: 'help',
    description: 'Show available commands',
    execute: (ctx) => {
      const lines = commands.map((c) => `/${c.name} — ${c.description}`).join('\n');
      ctx.setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'tool' as const,
        toolCallId: 'help',
        toolName: '/help',
        content: lines,
      }]);
    },
  },
];

export function getCommands(): SlashCommand[] {
  return commands;
}

export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}

export function matchCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const name = trimmed.slice(1).split(/\s/)[0]!.toLowerCase();
  return commands.find((c) => c.name === name) ?? null;
}
