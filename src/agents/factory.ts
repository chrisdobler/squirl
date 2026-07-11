import type { AgentDescriptor, AgentKind, ClaudePermissionMode, CodexSandbox } from './types.js';
import type { EffortLevel } from '../types.js';

export interface BuildDescriptorParams {
  kind: AgentKind;
  cwd: string;
  id?: string;
  label?: string;
  specialty?: string;
  model?: string;
  effort?: EffortLevel;
  bin?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
}

/** Default room handle per agent kind. */
export function defaultAgentId(kind: AgentKind): string {
  return kind === 'claude-code' ? 'cc' : 'codex';
}

/** Build a descriptor with conservative safety defaults (Claude 'default', Codex 'read-only'). */
export function buildAgentDescriptor(params: BuildDescriptorParams): AgentDescriptor {
  const id = params.id ?? defaultAgentId(params.kind);
  return {
    id,
    kind: params.kind,
    label: params.label ?? params.kind,
    specialty: params.specialty,
    transport: 'local',
    cwd: params.cwd,
    bin: params.bin,
    model: params.model,
    effort: params.effort,
    permissionMode: params.kind === 'claude-code' ? params.permissionMode ?? 'default' : undefined,
    sandbox: params.kind === 'codex' ? params.sandbox ?? 'read-only' : undefined,
  };
}
