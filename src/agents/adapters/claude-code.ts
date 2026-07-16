import { readFileSync, statSync } from 'node:fs';

import { query, type HookInput, type HookJSONOutput, type PermissionUpdate, type Query } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeParser } from '../parse/claude-stream.js';
import { boundedInput, SessionPermissionBroker } from '../permissions.js';
import type { AgentDescriptor, AgentInteractionResponse, AgentTransport, StreamParser } from '../types.js';
import { BaseAgentSession } from './base.js';

/**
 * Claude's bundled deep-research workflow currently asks up to 25 claims for
 * three verifier votes each. That fan-out cannot complete inside the
 * provider's background-workflow deadline, so an entire concurrency batch is
 * repeatedly interrupted before synthesis. Keep the provider-authored
 * workflow intact except for its explicit verification budget. The generated
 * source is supplied by the SDK as a derived `script` field, so this works for
 * both first launches and resumeFromRunId calls without mutating files in the
 * user's Claude session directory.
 */
export const CLAUDE_DEEP_RESEARCH_MAX_FETCH = 10;
export const CLAUDE_DEEP_RESEARCH_MAX_VERIFY_CLAIMS = 5;

function capScriptConstant(script: string, name: string, maximum: number): string {
  const pattern = new RegExp(`(\\bconst\\s+${name}\\s*=\\s*)(\\d+)`);
  const match = script.match(pattern);
  if (!match || Number(match[2]) <= maximum) return script;
  return script.replace(pattern, `$1${maximum}`);
}

export function boundClaudeWorkflowInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'Workflow' || typeof input.script !== 'string') return input;
  const isDeepResearch = /\bname\s*:\s*['"]deep-research['"]/.test(input.script);
  if (!isDeepResearch) return input;
  const bounded = capScriptConstant(
    capScriptConstant(input.script, 'MAX_FETCH', CLAUDE_DEEP_RESEARCH_MAX_FETCH),
    'MAX_VERIFY_CLAIMS',
    CLAUDE_DEEP_RESEARCH_MAX_VERIFY_CLAIMS,
  ).replace(
    // The bundled workflow lets every high-relevance URL bypass an exhausted
    // fetch budget. In a broad query that makes MAX_FETCH advisory and can
    // still create an unbounded extractor wave. Make the existing counter a
    // real ceiling; ranking still ensures each searcher's strongest URLs are
    // considered first.
    /if\s*\(fetchSlots\s*<=\s*0\s*&&\s*relRank\[r\.relevance\]\s*>=\s*1\)/,
    'if (fetchSlots <= 0)',
  )
    // Keep the fetch budget representative: two top URLs per search angle
    // prevents the first completed search from consuming every slot.
    .replace('const novel = sorted.filter(', 'const novel = sorted.slice(0, 2).filter(')
    // Retain the originating angle on claims so verification can cover the
    // whole research question instead of taking several claims from one repo.
    .replace(
      'claims: ext.claims.map(c => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })),',
      'claims: ext.claims.map(c => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality, sourceAngle: searchResult.angle })),',
    )
    .replace(
      /const rankedClaims = \[\.\.\.allClaims\]\s*\n\s*\.sort\(\(a, b\) => \(impRank\[a\.importance\] - impRank\[b\.importance\]\) \|\| \(qualRank\[a\.sourceQuality\] - qualRank\[b\.sourceQuality\]\)\)\s*\n\s*\.slice\(0, MAX_VERIFY_CLAIMS\)/,
      [
        'const sortedClaims = [...allClaims]',
        '  .sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))',
        'const rankedClaims = []',
        'const representedAngles = new Set()',
        'for (const claim of sortedClaims) {',
        '  if (rankedClaims.length >= MAX_VERIFY_CLAIMS) break',
        '  if (claim.sourceAngle && !representedAngles.has(claim.sourceAngle)) {',
        '    rankedClaims.push(claim)',
        '    representedAngles.add(claim.sourceAngle)',
        '  }',
        '}',
        'for (const claim of sortedClaims) {',
        '  if (rankedClaims.length >= MAX_VERIFY_CLAIMS) break',
        '  if (!rankedClaims.includes(claim)) rankedClaims.push(claim)',
        '}',
      ].join('\n'),
    );
  if (bounded === input.script) return input;
  return {
    ...input,
    script: bounded,
  };
}

function workflowInputForBudgeting(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.script === 'string') return record;
  if (typeof record.scriptPath !== 'string') return record;
  try {
    // Reading the same file the Workflow tool is about to execute does not
    // expand its authority. Refuse unexpectedly large files before loading.
    if (statSync(record.scriptPath).size > 1_000_000) return record;
    return { ...record, script: readFileSync(record.scriptPath, 'utf8') };
  } catch {
    return record;
  }
}

export async function claudeWorkflowBudgetHook(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Workflow') return { continue: true };
  const candidate = workflowInputForBudgeting(input.tool_input);
  if (!candidate) return { continue: true };
  const bounded = boundClaudeWorkflowInput(input.tool_name, candidate);
  if (bounded === candidate) return { continue: true };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: bounded,
    },
  };
}

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
  private oneShotToolApprovals: Array<{ toolName: string; input: Record<string, unknown> }> = [];

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
        hooks: {
          // PreToolUse runs even in bypassPermissions mode; canUseTool below
          // remains a second guard for normal permission-reviewed sessions.
          PreToolUse: [{ matcher: 'Workflow', hooks: [claudeWorkflowBudgetHook] }],
        },
        canUseTool: async (toolName, input, options) => {
          const boundedWorkflowInput = boundClaudeWorkflowInput(toolName, input);
          const approvalIndex = this.oneShotToolApprovals.findIndex((approval) => (
            approval.toolName === toolName
            && Object.keys(approval.input).every((key) => input[key] === approval.input[key])
            // The Claude SDK expands scriptPath into the loaded script source before
            // permission review. That derived field is safe only because the exact
            // scriptPath/run/args tuple above still has to match.
            && Object.keys(input).every((key) => key in approval.input || key === 'script')
          ));
          if (approvalIndex >= 0) {
            this.oneShotToolApprovals.splice(approvalIndex, 1);
            return { behavior: 'allow', updatedInput: boundedWorkflowInput };
          }
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
          return { behavior: 'allow', updatedInput: boundedWorkflowInput, ...(decision === 'allow-session' && updates ? { updatedPermissions: updates } : {}) };
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

  preapproveToolOnce(toolName: string, input: Record<string, unknown>): boolean {
    this.oneShotToolApprovals.push({ toolName, input: { ...input } });
    return true;
  }

  async interrupt(): Promise<void> {
    this.permissions.denyAll();
    this.oneShotToolApprovals = [];
    this.current?.close();
    this.current = null;
  }

  async stop(): Promise<void> {
    await this.interrupt();
    this.setStatus('stopped');
  }
}
