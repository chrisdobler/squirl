import { query, type PermissionUpdate, type Query } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeParser } from '../parse/claude-stream.js';
import { boundedInput, SessionPermissionBroker } from '../permissions.js';
import type { AgentDescriptor, AgentInteractionResponse, AgentTransport, StreamParser } from '../types.js';
import { BaseAgentSession } from './base.js';

function safeSessionUpdates(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | undefined {
  const safe = (suggestions ?? []).flatMap((suggestion): PermissionUpdate[] => {
    if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
      return [{ ...suggestion, destination: 'session' }];
    }
    if (suggestion.type === 'addDirectories') return [{ ...suggestion, destination: 'session' }];
    return [];
  });
  return safe.length ? safe : undefined;
}

function sessionScopeLabel(toolName: string, input: Record<string, unknown>, updates?: PermissionUpdate[]): string {
  const directory = updates?.find((update) => update.type === 'addDirectories');
  if (directory?.type === 'addDirectories') return `Always allow ${directory.directories.join(', ')} for this session`;
  const rule = updates?.find((update) => update.type === 'addRules');
  if (rule?.type === 'addRules') {
    const detail = rule.rules.map((item) => item.ruleContent || item.toolName).join(', ');
    return `Always allow ${detail} for this session`;
  }
  return `Always allow this ${toolName} request for this session`;
}

/** Claude Agent SDK adapter. Each Squirl turn resumes the prior Claude session. */
export class ClaudeCodeAdapter extends BaseAgentSession {
  private parser: StreamParser;
  private current: Query | null = null;
  private permissions = new SessionPermissionBroker((request) => this.emit({ type: 'interaction-request', participantId: this.descriptor.id, request }));

  constructor(descriptor: AgentDescriptor, transport: AgentTransport) {
    super(descriptor, transport);
    this.parser = createClaudeParser({ participantId: descriptor.id, newMessageId: () => this.nextMessageId() });
  }

  /** Retained for diagnostics and compatibility tests; production uses the SDK options below. */
  buildArgs(): string[] {
    const d = this.descriptor;
    const args = ['--permission-mode', d.permissionMode ?? 'acceptEdits'];
    if (d.model) args.push('--model', d.model);
    if (d.effort) args.push('--effort', d.effort);
    if (d.sessionId) args.push('--resume', d.sessionId);
    return args;
  }

  async start(): Promise<void> {
    this.setStatus('ready');
    this.emit({ type: 'session-status', participantId: this.descriptor.id, status: 'ready', sessionId: this.descriptor.sessionId, model: this.descriptor.model });
  }

  async send(text: string): Promise<void> {
    if (this.current) throw new Error(`Agent ${this.descriptor.id} is already busy`);
    const mode = this.descriptor.permissionMode ?? 'acceptEdits';
    const current = query({
      prompt: text,
      options: {
        cwd: this.descriptor.cwd,
        additionalDirectories: [this.descriptor.cwd],
        ...(this.descriptor.bin ? { pathToClaudeCodeExecutable: this.descriptor.bin } : {}),
        ...(this.descriptor.model ? { model: this.descriptor.model } : {}),
        ...(this.descriptor.effort && this.descriptor.effort !== 'off' && this.descriptor.effort !== 'minimal' ? { effort: this.descriptor.effort } : {}),
        ...(this.descriptor.sessionId ? { resume: this.descriptor.sessionId } : {}),
        permissionMode: mode,
        allowDangerouslySkipPermissions: mode === 'bypassPermissions',
        includePartialMessages: true,
        settingSources: this.descriptor.bare ? [] : ['user', 'project', 'local'],
        canUseTool: async (toolName, input, options) => {
          const updates = safeSessionUpdates(options.suggestions);
          const decision = await this.permissions.request({
            title: options.title ?? `${this.descriptor.label} wants to use ${toolName}`,
            message: options.description ?? options.decisionReason,
            toolName,
            input: boundedInput(input),
            resource: options.blockedPath,
            ...(updates ? { sessionScope: { key: options.requestId, label: sessionScopeLabel(toolName, input, updates) } } : {}),
          });
          if (decision === 'deny') return { behavior: 'deny', message: 'Denied by the user in Squirl.' };
          return { behavior: 'allow', updatedInput: input, ...(decision === 'allow-session' && updates ? { updatedPermissions: updates } : {}) };
        },
      },
    });
    this.current = current;
    this.setStatus('busy');
    try {
      for await (const message of current) {
        if ('session_id' in message && typeof message.session_id === 'string') this.descriptor.sessionId = message.session_id;
        const normalized = message.type === 'result' && message.is_error && !('result' in message)
          ? { ...message, result: 'errors' in message ? message.errors.join('\n') : 'Claude execution failed.' }
          : message;
        for (const event of this.parser.push(JSON.stringify(normalized))) {
          this.trackStatus(event);
          this.emit(event);
        }
      }
    } catch (error) {
      this.emit({ type: 'error', participantId: this.descriptor.id, message: error instanceof Error ? error.message : String(error) });
      this.emit({ type: 'turn-end', participantId: this.descriptor.id });
    } finally {
      if (this.current === current) this.current = null;
      if (this.status === 'busy') this.setStatus('ready');
    }
  }

  async respondToInteraction(id: string, response: AgentInteractionResponse): Promise<void> {
    this.permissions.respond(id, response);
  }

  async interrupt(): Promise<void> {
    this.permissions.denyAll();
    this.current?.close();
    this.current = null;
  }

  async stop(): Promise<void> {
    await this.interrupt();
    this.setStatus('stopped');
  }
}
