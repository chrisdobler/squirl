import { describe, expect, it } from 'vitest';

import { buildAgentDescriptor, defaultAgentId } from './factory.js';

describe('agent descriptor factory', () => {
  it('gives Claude write access by default while preserving explicit modes', () => {
    expect(buildAgentDescriptor({ kind: 'claude-code', cwd: '/repo' }).permissionMode).toBe('acceptEdits');
    expect(buildAgentDescriptor({ kind: 'claude-code', cwd: '/repo', permissionMode: 'plan' }).permissionMode).toBe('plan');
  });

  it('gives Codex bounded write access by default while preserving explicit overrides', () => {
    expect(buildAgentDescriptor({ kind: 'codex', cwd: '/repo' }).sandbox).toBe('workspace-write');
    expect(buildAgentDescriptor({ kind: 'codex', cwd: '/repo', sandbox: 'read-only' }).sandbox).toBe('read-only');
  });

  it('gives PI its canonical handle and full coding posture by default', () => {
    expect(defaultAgentId('pi')).toBe('pi');
    expect(buildAgentDescriptor({ kind: 'pi', cwd: '/repo' })).toMatchObject({
      id: 'pi', kind: 'pi', label: 'pi', piToolMode: 'coding',
    });
  });

  it('keeps PI-only thinking levels away from other harnesses', () => {
    expect(() => buildAgentDescriptor({ kind: 'codex', cwd: '/repo', effort: 'minimal' })).toThrow('only supported by PI');
  });
});
