import type { AgentDescriptor, AgentKind, ClaudePermissionMode, CodexSandbox } from './types.js';

export interface BuildDescriptorParams {
  kind: AgentKind;
  cwd: string;
  id?: string;
  label?: string;
  model?: string;
  bin?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
}

/** Default @mention handle per agent kind. */
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
    transport: 'local',
    cwd: params.cwd,
    bin: params.bin,
    model: params.model,
    permissionMode: params.kind === 'claude-code' ? params.permissionMode ?? 'default' : undefined,
    sandbox: params.kind === 'codex' ? params.sandbox ?? 'read-only' : undefined,
  };
}
