import { parseMentions } from './mentions.js';

export interface DelegationAgent {
  id: string;
  label?: string;
  kind?: 'claude-code' | 'codex';
  connected: boolean;
}

export interface DelegationIntent {
  targetIds: string[];
  unavailableTargetIds: string[];
  originalRequest: string;
  task: string;
  trigger: 'mention' | 'natural-language';
}

function aliasesFor(agent: DelegationAgent): string[] {
  const aliases = new Set([agent.id.toLowerCase(), agent.label?.toLowerCase()].filter(Boolean) as string[]);
  if (agent.kind === 'claude-code') {
    aliases.add('cc');
    aliases.add('claude');
    aliases.add('claude code');
    aliases.add('claudecode');
    aliases.add('clod');
    aliases.add('clod code');
    aliases.add('clodcode');
    aliases.add('cloud code');
    aliases.add('cloudcode');
  } else if (agent.kind === 'codex') {
    aliases.add('codex');
    aliases.add('codex cli');
  }
  return [...aliases];
}

function mentionedAgents(text: string, agents: DelegationAgent[]): DelegationAgent[] {
  const lower = text.toLowerCase();
  return agents.map((agent) => {
    let position = Number.POSITIVE_INFINITY;
    for (const alias of aliasesFor(agent)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`, 'i').exec(lower);
      if (match && match.index < position) position = match.index;
    }
    return { agent, position };
  }).filter((match) => Number.isFinite(match.position))
    .sort((a, b) => a.position - b.position)
    .map((match) => match.agent);
}

export function parseDelegationIntent(input: string, agents: DelegationAgent[]): DelegationIntent | null {
  const originalRequest = input.trim();
  if (!originalRequest) return null;

  const mentionIds = parseMentions(originalRequest, agents.map((agent) => agent.id)).targets;
  if (mentionIds.length > 0) {
    const leadingMentions = /^\s*(?:@[a-zA-Z0-9_-]+\s*)+/;
    const task = originalRequest.replace(leadingMentions, '').trim() || originalRequest;
    const targets = mentionIds.map((id) => agents.find((agent) => agent.id === id)!).filter(Boolean);
    return {
      targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
      unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
      originalRequest,
      task,
      trigger: 'mention',
    };
  }

  const tellMatch = originalRequest.match(/\b(?:tell|ask|have)\s+(.+?)\s+to\s+([\s\S]+)$/i);
  const sendMatch = originalRequest.match(/\bsend\s+([\s\S]+?)\s+to\s+(.+)$/i);
  const agentPhrase = tellMatch?.[1] ?? sendMatch?.[2];
  const task = (tellMatch?.[2] ?? sendMatch?.[1])?.trim();
  if (!agentPhrase || !task) return null;

  const targets = mentionedAgents(agentPhrase, agents);
  if (targets.length === 0) return null;
  return {
    targetIds: targets.filter((agent) => agent.connected).map((agent) => agent.id),
    unavailableTargetIds: targets.filter((agent) => !agent.connected).map((agent) => agent.id),
    originalRequest,
    task,
    trigger: 'natural-language',
  };
}
