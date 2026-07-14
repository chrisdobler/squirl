import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Participant } from '../agents/types.js';
import { AgentEditForm, AgentPanel, isAgentModeCycleShortcut, nextClaudePermissionMode, nextCodexSandbox } from './renderer.js';
import { defaultUiState } from './ui-state.js';

const codex: Participant = {
  id: 'reviewer', kind: 'codex', label: 'reviewer', color: 'magenta', status: 'ready', cwd: '/workspace',
};

describe('AgentPanel', () => {
  it('cycles safe Claude and Codex modes without entering dangerous access', () => {
    expect(nextClaudePermissionMode('default')).toBe('acceptEdits');
    expect(nextClaudePermissionMode('acceptEdits')).toBe('plan');
    expect(nextClaudePermissionMode('plan')).toBe('default');
    expect(nextClaudePermissionMode('bypassPermissions')).toBe('default');
    expect(nextCodexSandbox('read-only')).toBe('workspace-write');
    expect(nextCodexSandbox('workspace-write')).toBe('read-only');
    expect(nextCodexSandbox('danger-full-access')).toBe('read-only');
    expect(isAgentModeCycleShortcut({ key: 'Tab', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false })).toBe(true);
    expect(isAgentModeCycleShortcut({ key: 'Tab', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
    expect(isAgentModeCycleShortcut({ key: 'Tab', shiftKey: true, altKey: false, ctrlKey: true, metaKey: false })).toBe(false);
  });

  it('renders an Edit action next to every connected CLI agent', () => {
    const html = renderToStaticMarkup(React.createElement(AgentPanel, {
      participants: [codex, { id: 'writer', kind: 'claude-code', label: 'writer', color: 'blue', status: 'ready' }],
      profiles: [],
      selectedAgentId: 'reviewer',
      defaultCwd: '/workspace',
      onAdd: async () => undefined,
      onUpdate: async (id: string) => ({ id }),
      onStop: async () => undefined,
      initialState: { ...defaultUiState().agent, kind: 'codex' },
      onStateChange: () => undefined,
    }));

    expect(html.match(/>Edit<\/button>/g)).toHaveLength(2);
    expect(html).toContain('agentRosterItem selected');
    expect(html).toContain('id="agent-row-reviewer"');
    expect(html).toContain('File access');
    expect(html).toContain('Workspace write — selected project only');
    expect(html).toContain('Full machine access — dangerous');
  });

  it('renders a prefilled editor with save and cancel controls', () => {
    const html = renderToStaticMarkup(React.createElement(AgentEditForm, {
      participant: codex,
      profile: { profileId: 'profile-1', kind: 'codex', id: 'reviewer', model: 'gpt-test', effort: 'high', cwd: '/workspace', sandbox: 'read-only' },
      defaultCwd: '/fallback',
      agentModels: [{ id: 'gpt-test', label: 'GPT Test' }],
      agentModelsLoading: false,
      onSave: async () => undefined,
      onCancel: () => undefined,
    }));

    expect(html).toContain('Edit @reviewer');
    expect(html).toContain('value="reviewer"');
    expect(html).toContain('value="/workspace"');
    expect(html).toContain('value="gpt-test" selected');
    expect(html).toContain('value="high" selected');
    expect(html).toContain('value="read-only" selected');
    expect(html).toContain('Full machine access — dangerous');
    expect(html).toContain('>Cancel</button>');
    expect(html).toContain('Save &amp; reconnect');
  });

  it('renders Claude Code model choices as a dropdown', () => {
    const html = renderToStaticMarkup(React.createElement(AgentEditForm, {
      participant: { id: 'writer', kind: 'claude-code', label: 'writer', color: 'blue', status: 'ready' },
      profile: { profileId: 'profile-2', kind: 'claude-code', id: 'writer', model: 'opus', permissionMode: 'acceptEdits' },
      defaultCwd: '/workspace',
      agentModels: [{ id: 'fable', label: 'Fable' }, { id: 'opus', label: 'Opus' }],
      agentModelsLoading: false,
      onSave: async () => undefined,
      onCancel: () => undefined,
    }));

    expect(html).toContain('<select');
    expect(html).toContain('Fable (fable)');
    expect(html).toContain('value="opus" selected');
    expect(html).toContain('Permission mode');
    expect(html).toContain('value="acceptEdits" selected');
    expect(html).toContain('Shift+Tab cycles Manual, Accept edits, and Plan');
    expect(html).not.toContain('placeholder="CLI default"');
  });

  it('renders PI as a third harness with thinking and unsandboxed tool controls', () => {
    const html = renderToStaticMarkup(React.createElement(AgentEditForm, {
      participant: { id: 'pi', kind: 'pi', label: 'pi', color: 'gray', status: 'ready' },
      profile: { profileId: 'profile-pi', kind: 'pi', id: 'pi', model: 'openai/gpt-test', effort: 'minimal', piToolMode: 'coding' },
      defaultCwd: '/workspace',
      agentModels: [{ id: 'openai/gpt-test', label: 'gpt-test' }],
      agentModelsLoading: false,
      onSave: async () => undefined,
      onCancel: () => undefined,
    }));
    expect(html).toContain('PI Agent');
    expect(html).toContain('value="minimal" selected');
    expect(html).toContain('coding (unsandboxed)');
    expect(html).toContain('PI does not provide permission prompts or a sandbox');
  });
});
