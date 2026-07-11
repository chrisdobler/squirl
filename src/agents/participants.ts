// Single source of truth for participant identity, labels, and colors — used by BOTH the Ink
// TUI and the web renderer so a given participant looks the same everywhere.

import type { AgentDescriptor, Participant, ParticipantColor } from './types.js';

export const USER_PARTICIPANT: Participant = { id: 'user', kind: 'user', label: 'you', color: 'cyan' };
export const SQUIRL_PARTICIPANT: Participant = { id: 'squirl', kind: 'local-llm', label: 'squirl', color: 'green' };

/** Colors handed to remote agents as they join (cyan/green are reserved for user/squirl). */
const AGENT_PALETTE: ParticipantColor[] = ['yellow', 'magenta', 'blue', 'gray'];

export function pickAgentColor(index: number): ParticipantColor {
  return AGENT_PALETTE[index % AGENT_PALETTE.length]!;
}

/** Short human label for an agent's permission/sandbox posture, surfaced in the UI. */
export function describeAgentMode(descriptor: AgentDescriptor): string {
  if (descriptor.kind === 'codex') return `sandbox: ${descriptor.sandbox ?? 'read-only'}`;
  return `permission: ${descriptor.permissionMode ?? 'default'}`;
}

export function participantFromDescriptor(descriptor: AgentDescriptor, colorIndex: number): Participant {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    label: descriptor.label,
    specialty: descriptor.specialty,
    color: pickAgentColor(colorIndex),
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
