import type { Message } from '../types.js';

export interface ModelActionCapabilities {
  nativeToolCalls: boolean;
  structuredOutput: boolean;
}

export interface HandoffAction {
  type: 'handoff';
  targetId: string;
  task: string;
  context?: string;
  successCriteria?: string;
}

export type SquirlAction = HandoffAction;

export type SquirlActionDecision =
  | { type: 'respond' }
  | { type: 'action'; action: SquirlAction };

export type SquirlActionResolution =
  | { state: 'respond' }
  | { state: 'proposed'; action: SquirlAction }
  | { state: 'dispatched'; action: SquirlAction; turnId: string }
  | { state: 'rejected'; action?: SquirlAction; reason: string };

export interface ActionPlanningAgent {
  id: string;
  label?: string;
  connected: boolean;
  specialty?: string;
  status?: string;
  cwd?: string;
  currentAssignment?: string;
}

export interface RawActionDecision {
  decision?: unknown;
  targetId?: unknown;
  task?: unknown;
  context?: unknown;
  successCriteria?: unknown;
}

export const PROPOSE_HANDOFF_TOOL = {
  type: 'function' as const,
  function: {
    name: 'propose_handoff',
    description: 'Propose handing work to one connected specialist. This only proposes; the runtime decides whether user confirmation is required.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Exact id of a connected agent supplied in the planning context.' },
        task: { type: 'string', description: 'Concrete work for the target agent.' },
        context: { type: 'string', description: 'Only the relevant context the specialist needs.' },
        successCriteria: { type: 'string', description: 'Observable completion criteria.' },
      },
      required: ['targetId', 'task', 'context', 'successCriteria'],
      additionalProperties: false,
    },
  },
};

export const ACTION_DECISION_JSON_SCHEMA = {
  name: 'squirl_action_decision',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['respond', 'handoff'] },
      targetId: { type: 'string' },
      task: { type: 'string' },
      context: { type: 'string' },
      successCriteria: { type: 'string' },
    },
    required: ['decision', 'targetId', 'task', 'context', 'successCriteria'],
    additionalProperties: false,
  },
};

export const ACTION_PLANNER_SYSTEM_PROMPT = `/no_think
You are Squirl's structured action planner. Decide whether Squirl should answer the newest user request itself or propose handing concrete work to exactly one connected specialist.

Choose respond for clear informational questions, conversation, questions about prior work, or whenever no specialist is clearly better suited. Do not delegate merely because an agent is available. Choose handoff only when a listed connected specialist is clearly the right owner of actionable work.

This is only a proposal. Never claim the user authorized it and never claim it was dispatched. Use only exact agent ids supplied in the input. Keep context relevant and success criteria observable.`;

export function actionPlannerInput(
  request: string,
  agents: ActionPlanningAgent[],
  recentContext: Message[],
): string {
  return JSON.stringify({
    request,
    knownAgents: agents.map(({ id, label, connected, specialty, status, cwd, currentAssignment }) => ({ id, label, connected, specialty, status, cwd, currentAssignment })),
    recentContext: recentContext.slice(-12)
      .filter((message) => message.role !== 'tool' && message.role !== 'activity')
      .map((message) => ({ role: message.role, participantId: message.participantId, content: message.content.slice(0, 2_000) })),
  });
}

export function parseSquirlActionDecision(raw: RawActionDecision, agents: ActionPlanningAgent[]): SquirlActionDecision {
  if (raw.decision !== 'handoff') return { type: 'respond' };
  if (typeof raw.targetId !== 'string' || typeof raw.task !== 'string') return { type: 'respond' };
  const target = agents.find((agent) => agent.id === raw.targetId && agent.connected);
  const task = raw.task.trim();
  if (!target || !task) return { type: 'respond' };
  const context = typeof raw.context === 'string' ? raw.context.trim() : '';
  const successCriteria = typeof raw.successCriteria === 'string' ? raw.successCriteria.trim() : '';
  return {
    type: 'action',
    action: {
      type: 'handoff', targetId: target.id, task,
      ...(context ? { context } : {}),
      ...(successCriteria ? { successCriteria } : {}),
    },
  };
}
