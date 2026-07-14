// Single source of truth for participant identity, labels, and colors — used by BOTH the Ink
// TUI and the web renderer so a given participant looks the same everywhere.

import type { AgentDescriptor, Participant, ParticipantColor } from './types.js';

export const USER_PARTICIPANT: Participant = { id: 'user', kind: 'user', label: 'you', color: 'cyan' };
export const SQUIRL_PARTICIPANT: Participant = { id: 'squirl', kind: 'local-llm', label: 'squirl', color: 'orange' };

/** Stable identity colors for remote agents, ordered to avoid status-like colors initially. */
export const AGENT_COLOR_PALETTE: readonly ParticipantColor[] = [
  'magenta', 'blue', 'gray', 'green', 'red', 'yellow', 'teal', 'violet', 'brown',
];

/** Shared RGB values keep participant identities consistent between Ink and web renderers. */
export const PARTICIPANT_COLOR_VALUE: Readonly<Record<ParticipantColor, string>> = {
  cyan: '#22d3ee',
  magenta: '#e879f9',
  orange: '#fb923c',
  blue: '#60a5fa',
  green: '#4ade80',
  red: '#f87171',
  yellow: '#facc15',
  gray: '#9ca3af',
  teal: '#2dd4bf',
  violet: '#a78bfa',
  brown: '#b08968',
};

export function pickAgentColor(inUse: Iterable<ParticipantColor>): ParticipantColor {
  const used = new Set(inUse);
  const available = AGENT_COLOR_PALETTE.find((color) => !used.has(color));
  if (!available) throw new Error(`Cannot add another agent: all ${AGENT_COLOR_PALETTE.length} identity colors are in use.`);
  return available;
}

/** Short human label for an agent's permission/sandbox posture, surfaced in the UI. */
export function describeAgentMode(descriptor: AgentDescriptor): string {
  if (descriptor.kind === 'pi') return `tools: ${descriptor.piToolMode ?? 'coding'}, approval: ${descriptor.piApprovalMode ?? 'acceptEdits'}`;
  if (descriptor.kind === 'codex') return `sandbox: ${descriptor.sandbox ?? 'workspace-write'}, approval: ${descriptor.approvalPolicy ?? 'on-request'}`;
  return `permission: ${descriptor.permissionMode ?? 'acceptEdits'}`;
}

export function participantFromDescriptor(descriptor: AgentDescriptor, color: ParticipantColor): Participant {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    label: descriptor.label,
    specialty: descriptor.specialty,
    color,
    status: 'starting',
    mode: describeAgentMode(descriptor),
    cwd: descriptor.cwd,
  };
}

export function buildRegistry(participants: Participant[]): Map<string, Participant> {
  return new Map(participants.map((p) => [p.id, p]));
}

/** Display the participant a user message was addressed to. Legacy messages target Squirl. */
export function addressedParticipantLabel(
  message: { role: string; participantId?: string },
  _registry: Map<string, Participant>,
): string {
  const recipientId = message.participantId ?? SQUIRL_PARTICIPANT.id;
  return `@${recipientId}`;
}

/** The participants that occupy "the room" — squirl's local LLM and any remote agents (not the user). */
export function roomMembers(participants: Participant[]): Participant[] {
  return participants.filter((p) => p.kind !== 'user');
}

/** Resolve the participant a message belongs to, for label/color rendering. */
export function resolveParticipant(
  message: { role: string; participantId?: string },
  registry: Map<string, Participant>,
): Participant {
  if (message.role === 'user') {
    return registry.get('user') ?? USER_PARTICIPANT;
  }
  if (message.participantId) {
    return registry.get(message.participantId) ?? {
      id: message.participantId,
      kind: 'claude-code',
      label: message.participantId,
      color: 'gray',
    };
  }
  return registry.get('squirl') ?? SQUIRL_PARTICIPANT;
}
