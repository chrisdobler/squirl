import type { Message } from '../types.js';
export interface ActivityParticipant {
  id: string;
  label: string;
  kind: string;
  status?: string;
  specialty?: string;
}

export interface AgentActivity {
  id: string;
  label: string;
  specialty?: string;
  status: string;
  latestAssignment?: string;
  assignmentHistory: string[];
  recentWork: string[];
}

const compact = (value: string, max = 280): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Derive a deterministic room ledger from participant-addressed requests and responses. */
export function deriveAgentActivity(participants: ActivityParticipant[], messages: Message[]): AgentActivity[] {
  return participants
    .filter((participant) => participant.kind !== 'user' && participant.kind !== 'local-llm')
    .map((participant) => {
      const assigned = messages.filter((message) => message.role === 'user' && message.participantId === participant.id);
      const outputs = messages.filter((message) => message.role === 'assistant' && message.participantId === participant.id);
      return {
        id: participant.id,
        label: participant.label,
        specialty: participant.specialty,
        status: participant.status ?? 'status unknown',
        latestAssignment: assigned.length ? compact(assigned[assigned.length - 1]!.content) : undefined,
        assignmentHistory: [...new Set(assigned.map((message) => compact(message.content)))].slice(-12),
        recentWork: outputs.slice(-3).map((message) => compact(message.content)).filter(Boolean),
      };
    });
}

export function formatAgentActivity(activity: AgentActivity[]): string {
  if (activity.length === 0) return 'No specialized agents are currently in the room.';
  return activity.map((agent) => {
    const lines = [`@${agent.id} (${agent.label})`, `Status: ${agent.status}`];
    if (agent.specialty) lines.push(`Specialty: ${agent.specialty}`);
    const assignmentLabel = agent.status === 'busy' || agent.status === 'starting' ? 'Current assignment' : 'Latest assignment';
    lines.push(`${assignmentLabel}: ${agent.latestAssignment ?? 'none recorded'}`);
    lines.push(`Assignment history: ${agent.assignmentHistory.length ? agent.assignmentHistory.join(' | ') : 'none recorded'}`);
    lines.push(`Recent work: ${agent.recentWork.length ? agent.recentWork.join(' | ') : 'none recorded'}`);
    return lines.join('\n');
  }).join('\n\n');
}
