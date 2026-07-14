import type { AgentDescriptor, AgentKind, ClaudePermissionMode, CodexSandbox, PiToolMode } from './types.js';
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
  piToolMode?: PiToolMode;
}

/** Default room handle per agent kind. */
export function defaultAgentId(kind: AgentKind): string {
  if (kind === 'claude-code') return 'cc';
  return kind;
}

/** Build a descriptor with bounded coding defaults (Claude 'acceptEdits', Codex 'workspace-write'). */
export function buildAgentDescriptor(params: BuildDescriptorParams): AgentDescriptor {
  if (params.kind !== 'pi' && (params.effort === 'off' || params.effort === 'minimal')) {
    throw new Error(`${params.effort} thinking is only supported by PI agents.`);
  }
  if (params.piToolMode && params.piToolMode !== 'coding' && params.piToolMode !== 'read-only') {
    throw new Error(`Unknown PI tool mode "${String(params.piToolMode)}".`);
  }
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
    permissionMode: params.kind === 'claude-code' ? params.permissionMode ?? 'acceptEdits' : undefined,
    sandbox: params.kind === 'codex' ? params.sandbox ?? 'workspace-write' : undefined,
    piToolMode: params.kind === 'pi' ? params.piToolMode ?? 'coding' : undefined,
  };
}
