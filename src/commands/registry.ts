import { buildSystemPrompt } from '../context/system-prompt.js';
import { getModelConfig } from '../model-config.js';
import { platform } from 'node:os';
import type { Orchestrator } from '../orchestrator.js';
import type { Message } from '../types.js';

export interface CommandContext {
  orchestrator: Orchestrator;
  messages: Message[];
  workingDir: string;
  modelId: string;
  setMessages: (fn: (prev: Message[]) => Message[]) => void;
  openContextPicker: () => void;
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
