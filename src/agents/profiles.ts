import type { AgentProfile, SquirlConfig } from '../config.js';
import type { AgentDescriptor, AgentKind } from './types.js';
import { defaultAgentId } from './factory.js';

const RESERVED_HANDLES = new Set(['user', 'squirl']);

export function normalizeAgentHandle(value: string): string {
  return value.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '');
}

export function validateAgentHandle(value: string, existingIds: string[] = [], currentId?: string): string {
  const id = normalizeAgentHandle(value);
  if (!id) throw new Error('Agent name must contain a letter or number.');
  if (RESERVED_HANDLES.has(id)) throw new Error(`@${id} is reserved.`);
  if (existingIds.some((candidate) => candidate.toLowerCase() === id && candidate.toLowerCase() !== currentId?.toLowerCase())) {
    throw new Error(`Agent "@${id}" already exists.`);
  }
  return id;
}

export function profileFromDescriptor(descriptor: AgentDescriptor, profileId?: string): AgentProfile {
  return {
    profileId: profileId ?? crypto.randomUUID(),
    kind: descriptor.kind,
    id: descriptor.id,
    label: descriptor.label,
    specialty: descriptor.specialty,
    model: descriptor.model,
    effort: descriptor.effort,
    bin: descriptor.bin,
    cwd: descriptor.cwd,
    permissionMode: descriptor.permissionMode,
    sandbox: descriptor.sandbox,
    piToolMode: descriptor.piToolMode,
    reconnect: true,
  };
}

export function upsertAgentProfile(config: SquirlConfig, profile: AgentProfile): SquirlConfig {
  const defaults = [...(config.agents?.defaults ?? [])];
  const index = defaults.findIndex((item) =>
    (profile.profileId && item.profileId === profile.profileId) ||
    (!!profile.id && item.id?.toLowerCase() === profile.id.toLowerCase()));
  if (index >= 0) defaults[index] = profile;
  else defaults.push(profile);
  return { ...config, agents: { ...config.agents, defaults } };
}

export function removeAgentProfile(config: SquirlConfig, id: string): SquirlConfig {
  const defaults = (config.agents?.defaults ?? []).filter((profile) => profile.id?.toLowerCase() !== id.toLowerCase());
  return { ...config, agents: { ...config.agents, defaults } };
}

export function materializeProfile(profile: AgentProfile, fallbackCwd: string): Required<Pick<AgentProfile, 'profileId' | 'kind' | 'id' | 'label' | 'cwd' | 'reconnect'>> & AgentProfile {
  const id = validateAgentHandle(profile.id ?? defaultAgentId(profile.kind));
  return {
    ...profile,
    profileId: profile.profileId ?? crypto.randomUUID(),
    id,
    label: profile.label ?? id,
    specialty: profile.specialty,
    cwd: profile.cwd ?? fallbackCwd,
    reconnect: profile.reconnect ?? true,
  };
}

export function nextAvailableAgentId(kind: AgentKind, existingIds: string[]): string {
  const base = defaultAgentId(kind);
  if (!existingIds.some((id) => id.toLowerCase() === base)) return base;
  let suffix = 2;
  while (existingIds.some((id) => id.toLowerCase() === `${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
