import { buildSystemPrompt } from '../context/system-prompt.js';
import { getModelConfig } from '../model-config.js';
import { platform } from 'node:os';
import { recall } from '../search/recall.js';
import { isVectorStoreError } from '../search/stores/chroma.js';
import type { Embedder, VectorStore } from '../search/types.js';
import type { Orchestrator } from '../orchestrator.js';
import type { Message } from '../types.js';
import { preview, roleLabel } from '../rewind.js';
import type { RewindRequest } from '../rewind.js';
import type { AgentKind } from '../agents/types.js';

export interface AgentSummary {
  id: string;
  label: string;
  status: string;
  mode: string;
}

export type AddAgentResult = { ok: true; id: string; label: string } | { ok: false; error: string };

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
  commandInput?: string;
  requestRewind?: (request: RewindRequest) => void;
  openRewindPicker?: () => void;
  addAgent?: (kind: AgentKind, opts?: { id?: string; model?: string }) => Promise<AddAgentResult>;
  stopAgent?: (id: string) => Promise<boolean>;
  listAgents?: () => AgentSummary[];
}

function pushToolMessage(ctx: CommandContext, name: string, content: string): void {
  ctx.setMessages((prev) => [...prev, {
    id: crypto.randomUUID(),
    role: 'tool' as const,
    toolCallId: name,
    toolName: `/${name}`,
    content,
  }]);
}

function normalizeAgentKind(token?: string): AgentKind | null {
  const t = (token ?? '').toLowerCase();
  if (t === 'claude-code' || t === 'claude' || t === 'cc') return 'claude-code';
  if (t === 'codex') return 'codex';
  return null;
}

function formatAgentList(agents: AgentSummary[]): string {
  if (agents.length === 0) return 'No agents connected. Add one with /agent add claude-code or /agent add codex.';
  return agents.map((a) => `@${a.id} — ${a.label} [${a.status}] ${a.mode}`).join('\n');
}

export interface SlashCommand {
  name: string;
  description: string;
  execute: (ctx: CommandContext) => void | Promise<void>;
}

function showRewindUsage(ctx: CommandContext, content = 'Usage: /rewind, /rewind list, /rewind last, or /rewind <number>'): void {
  ctx.setMessages((prev) => [...prev, {
    id: crypto.randomUUID(),
    role: 'tool' as const,
    toolCallId: 'rewind',
    toolName: '/rewind',
    content,
  }]);
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
          supportsTools: config.supportsTools,
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
          content: 'Index not enabled. Run /setup to configure ChromaDB v2 and an embedding provider.',
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
      try {
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
      } catch (err) {
        const content = isVectorStoreError(err)
          ? `Error: ${err.message}`
          : `Recall failed: ${err instanceof Error ? err.message : String(err)}`;
        ctx.setMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'tool' as const,
          toolCallId: 'recall', toolName: '/recall',
          content,
        }]);
      }
    },
  },
  {
    name: 'rewind',
    description: 'Remove later messages from context and history',
    execute: (ctx) => {
      const arg = ctx.commandInput?.trim().split(/\s+/).slice(1).join(' ').toLowerCase() ?? '';
      if (ctx.messages.length === 0) {
        showRewindUsage(ctx, 'No messages to rewind.');
        return;
      }
      if (!ctx.requestRewind) {
        showRewindUsage(ctx, 'Rewind is not available in this session.');
        return;
      }
      if (!arg) {
        if (ctx.openRewindPicker) {
          ctx.openRewindPicker();
        } else {
          showRewindUsage(ctx);
        }
        return;
      }

      if (arg === 'list') {
        const lines = ctx.messages.map((message, index) => {
          const number = String(index + 1).padStart(2, ' ');
          return `${number}. ${roleLabel(message)} — ${preview(message.content)}`;
        });
        showRewindUsage(ctx, lines.join('\n'));
        return;
      }

      if (arg === 'last') {
        let lastUserIndex = -1;
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
          if (ctx.messages[i]!.role === 'user') {
            lastUserIndex = i;
            break;
          }
        }
        if (lastUserIndex === -1) {
          showRewindUsage(ctx, 'No user turn found to rewind.');
          return;
        }
        const retainedCount = lastUserIndex;
        const removedCount = ctx.messages.length - retainedCount;
        const target = retainedCount > 0 ? ctx.messages[retainedCount - 1]! : null;
        ctx.requestRewind({
          targetMessageId: target?.id ?? null,
          retainedCount,
          removedCount,
          label: target
            ? `${retainedCount}. ${roleLabel(target)} — ${preview(target.content)}`
            : 'start of conversation',
        });
        return;
      }

      if (!/^\d+$/.test(arg)) {
        showRewindUsage(ctx);
        return;
      }
      const number = Number.parseInt(arg, 10);
      if (number < 1 || number > ctx.messages.length) {
        showRewindUsage(ctx, `Message ${number} is not in the current visible history. Run /rewind list.`);
        return;
      }
      if (number === ctx.messages.length) {
        showRewindUsage(ctx, 'Already at that message; nothing would be removed.');
        return;
      }

      const target = ctx.messages[number - 1]!;
      ctx.requestRewind({
        targetMessageId: target.id,
        retainedCount: number,
        removedCount: ctx.messages.length - number,
        label: `${number}. ${roleLabel(target)} — ${preview(target.content)}`,
      });
    },
  },
  {
    name: 'agent',
    description: 'Add, list, or stop a remote agent: /agent add <claude-code|codex> [id]',
    execute: async (ctx) => {
      if (!ctx.addAgent || !ctx.stopAgent || !ctx.listAgents) {
        pushToolMessage(ctx, 'agent', 'Remote agents are not available in this session.');
        return;
      }
      const tokens = (ctx.commandInput ?? '').trim().split(/\s+/);
      const sub = (tokens[1] ?? 'list').toLowerCase();

      if (sub === 'add') {
        const kind = normalizeAgentKind(tokens[2]);
        if (!kind) {
          pushToolMessage(ctx, 'agent', 'Usage: /agent add <claude-code|codex> [id]');
          return;
        }
        const result = await ctx.addAgent(kind, { id: tokens[3] });
        pushToolMessage(ctx, 'agent', result.ok
          ? `${result.label} joined as @${result.id}. Address it with "@${result.id} <message>".`
          : `Could not add agent: ${result.error}`);
        return;
      }

      if (sub === 'stop' || sub === 'remove') {
        const id = tokens[2];
        if (!id) {
          pushToolMessage(ctx, 'agent', 'Usage: /agent stop <id>');
          return;
        }
        const ok = await ctx.stopAgent(id);
        pushToolMessage(ctx, 'agent', ok ? `Stopped @${id}.` : `No agent @${id}.`);
        return;
      }

      pushToolMessage(ctx, 'agent', formatAgentList(ctx.listAgents()));
    },
  },
  {
    name: 'agents',
    description: 'List connected remote agents',
    execute: (ctx) => {
      if (!ctx.listAgents) {
        pushToolMessage(ctx, 'agents', 'Remote agents are not available in this session.');
        return;
      }
      pushToolMessage(ctx, 'agents', formatAgentList(ctx.listAgents()));
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
