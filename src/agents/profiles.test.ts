import { describe, expect, it } from 'vitest';
import { materializeProfile, nextAvailableAgentId, normalizeAgentHandle, removeAgentProfile, upsertAgentProfile, validateAgentHandle } from './profiles.js';

describe('agent profiles', () => {
  it('normalizes display names into handles', () => {
    expect(normalizeAgentHandle(' Claude Builder! ')).toBe('claude-builder');
  });

  it('rejects reserved and duplicate handles', () => {
    expect(() => validateAgentHandle('Squirl')).toThrow('reserved');
    expect(() => validateAgentHandle('Builder', ['builder'])).toThrow('already exists');
    expect(validateAgentHandle('Builder', ['builder'], 'builder')).toBe('builder');
  });

  it('assigns distinct defaults to multiple agents of one kind', () => {
    expect(nextAvailableAgentId('claude-code', [])).toBe('cc');
    expect(nextAvailableAgentId('claude-code', ['cc', 'cc-2'])).toBe('cc-3');
  });

  it('migrates legacy defaults and can upsert/remove them', () => {
    const profile = materializeProfile({ kind: 'codex', id: 'reviewer' }, '/repo');
    expect(profile).toMatchObject({ id: 'reviewer', label: 'reviewer', cwd: '/repo', reconnect: true });
    const config = upsertAgentProfile({}, profile);
    expect(config.agents?.defaults).toHaveLength(1);
    expect(removeAgentProfile(config, 'REVIEWER').agents?.defaults).toEqual([]);
  });

  it('preserves optional model effort on persisted profiles', () => {
    const profile = materializeProfile({ kind: 'claude-code', id: 'writer', model: 'fable', effort: 'medium' }, '/repo');
    expect(profile).toMatchObject({ model: 'fable', effort: 'medium' });
  });
});
