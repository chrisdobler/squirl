import { boundedInput, SessionPermissionBroker } from '../permissions.js';
import type { AgentDescriptor, AgentInteractionResponse, AgentTransport, SpawnHandle } from '../types.js';
import { BaseAgentSession } from './base.js';

type RpcId = string | number;
type JsonObject = Record<string, unknown>;

interface PersistentApprovalChoice {
  decision: unknown;
  label: string;
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function persistentApprovalChoice(available: unknown[] | undefined, isFile: boolean): PersistentApprovalChoice | undefined {
  if (!available) {
    return {
      decision: 'acceptForSession',
      label: isFile ? 'Always allow changes to these files for this session' : 'Always allow this command for this session',
    };
  }

  for (const decision of available) {
    if (decision === 'acceptForSession') {
      return {
        decision,
        label: isFile ? 'Always allow changes to these files for this session' : 'Always allow this command for this session',
      };
    }

    const value = object(decision);
    if (value.acceptWithExecpolicyAmendment) {
      return { decision, label: 'Always allow matching commands' };
    }

    const network = object(value.applyNetworkPolicyAmendment);
    const amendment = object(network.network_policy_amendment);
    if (amendment.action === 'allow' && typeof amendment.host === 'string') {
      return { decision, label: `Always allow network access to ${amendment.host}` };
    }
  }

  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, message: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function itemInfo(value: unknown): { id: string; type: string; name: string; input: unknown; result: string; ok: boolean } {
  const item = object(value);
  const type = typeof item.type === 'string' ? item.type : 'tool';
  const id = typeof item.id === 'string' ? item.id : '';
  const command = typeof item.command === 'string' ? item.command : item.command != null ? boundedInput(item.command) : '';
  const changes = item.changes ?? item.files ?? item.patch;
  const result = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput
    : typeof item.output === 'string' ? item.output
      : typeof item.error === 'string' ? item.error : '';
  const status = typeof item.status === 'string' ? item.status : '';
  return {
    id, type, name: type === 'commandExecution' ? 'Bash' : type === 'fileChange' ? 'Edit' : type,
    input: command ? { command } : changes ?? item,
    result, ok: !['failed', 'declined', 'error'].includes(status),
  };
}

/** Persistent Codex App Server adapter with bidirectional JSON-RPC approvals. */
export class CodexAdapter extends BaseAgentSession {
  private handle: SpawnHandle | null = null;
  private nextId = 0;
  private pendingRpc = new Map<RpcId, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();
  private permissions = new SessionPermissionBroker((request) => this.emit({ type: 'interaction-request', participantId: this.descriptor.id, request }));
  private approvalRequests = new Map<string, { rpcId: RpcId; method: string; available?: unknown[] }>();
  private messageId: string | null = null;
  private messageText = '';
  private turnId: string | null = null;

  buildArgs(): string[] { return ['app-server']; }

  private write(value: JsonObject): void {
    if (!this.handle) throw new Error(`Agent ${this.descriptor.id} is not started`);
    this.handle.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = ++this.nextId;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pendingRpc.set(id, { resolve, reject }));
  }

  private ensureMessage(): string {
    if (!this.messageId) {
      this.messageId = this.nextMessageId();
      this.messageText = '';
      this.emit({ type: 'message-start', participantId: this.descriptor.id, messageId: this.messageId, ...(this.descriptor.model ? { responseMeta: { model: this.descriptor.model } } : {}) });
    }
    return this.messageId;
  }

  private closeMessage(): void {
    if (!this.messageId) return;
    this.emit({ type: 'message-end', participantId: this.descriptor.id, messageId: this.messageId, content: this.messageText });
    this.messageId = null;
    this.messageText = '';
  }

  private async handleApproval(id: RpcId, method: string, params: JsonObject): Promise<void> {
    if (method === 'item/permissions/requestApproval') {
      this.emit({ type: 'error', participantId: this.descriptor.id, message: 'This Codex version requested an experimental permission profile that Squirl cannot safely narrow. The request was denied.' });
      this.write({ id, error: { code: -32601, message: 'Squirl does not support experimental permission profile grants.' } });
      return;
    }
    const command = typeof params.command === 'string' ? params.command : '';
    const isFile = method === 'item/fileChange/requestApproval';
    const itemId = typeof params.itemId === 'string' ? params.itemId : String(id);
    const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
    const persistentChoice = persistentApprovalChoice(available, isFile);
    const resource = command || (typeof params.grantRoot === 'string' ? params.grantRoot : undefined);
    const requestId = `codex:${String(id)}`;
    this.approvalRequests.set(requestId, { rpcId: id, method, available });
    const decision = await this.permissions.request({
      id: requestId,
      title: `${this.descriptor.label} wants to ${isFile ? 'change files' : 'run a command'}`,
      message: typeof params.reason === 'string' ? params.reason : undefined,
      toolName: isFile ? 'Edit' : 'Bash',
      input: boundedInput(command || params),
      resource,
      ...(persistentChoice ? { sessionScope: { key: itemId, label: persistentChoice.label } } : {}),
    });
    this.approvalRequests.delete(requestId);
    const result = decision === 'allow-session' && persistentChoice ? persistentChoice.decision : decision === 'allow-once' ? 'accept' : 'decline';
    this.write({ id, result: { decision: result } });
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    const id = message.id as RpcId | undefined;
    if (id !== undefined && typeof message.method !== 'string') {
      const pending = this.pendingRpc.get(id);
      if (!pending) return;
      this.pendingRpc.delete(id);
      if (message.error) pending.reject(new Error(String(object(message.error).message ?? 'Codex App Server request failed')));
      else pending.resolve(object(message.result));
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const params = object(message.params);
    if (id !== undefined && method.endsWith('/requestApproval')) {
      void this.handleApproval(id, method, params);
      return;
    }
    if (method === 'thread/started') {
      const thread = object(params.thread);
      const threadId = typeof thread.id === 'string' ? thread.id : typeof params.threadId === 'string' ? params.threadId : undefined;
      if (threadId) this.descriptor.sessionId = threadId;
      return;
    }
    if (method === 'turn/started') {
      const turn = object(params.turn);
      this.turnId = typeof turn.id === 'string' ? turn.id : null;
      return;
    }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const messageId = this.ensureMessage();
      this.messageText += params.delta;
      this.emit({ type: 'token', participantId: this.descriptor.id, messageId, token: params.delta });
      return;
    }
    if (method === 'item/started') {
      const info = itemInfo(params.item);
      if (info.type === 'commandExecution' || info.type === 'fileChange' || info.type === 'mcpToolCall') {
        this.closeMessage();
        this.emit({ type: 'tool-start', participantId: this.descriptor.id, toolId: info.id, toolName: info.name, input: info.input });
      }
      return;
    }
    if (method === 'item/completed') {
      const info = itemInfo(params.item);
      if (info.type === 'commandExecution' || info.type === 'fileChange' || info.type === 'mcpToolCall') {
        this.emit({ type: 'tool-end', participantId: this.descriptor.id, toolId: info.id, toolName: info.name, result: info.result || (info.ok ? '(ok)' : '(failed)'), ok: info.ok });
      }
      return;
    }
    if (method === 'turn/completed') {
      this.closeMessage();
      const turn = object(params.turn);
      if (turn.status === 'failed') this.emit({ type: 'error', participantId: this.descriptor.id, message: String(object(turn.error).message ?? 'Codex turn failed.') });
      this.turnId = null;
      this.emit({ type: 'turn-end', participantId: this.descriptor.id });
      this.setStatus('ready');
      return;
    }
    if (method === 'error') {
      this.emit({ type: 'error', participantId: this.descriptor.id, message: String(object(params.error).message ?? params.message ?? 'Codex App Server error') });
    }
  }

  async start(): Promise<void> {
    const handle = await this.transport.spawn({ command: this.descriptor.bin ?? 'codex', args: this.buildArgs(), cwd: this.descriptor.cwd });
    this.handle = handle;
    let stderr = '';
    handle.onStderr((line) => { stderr = `${stderr}\n${line}`.trim().slice(-4000); });
    handle.onStdout((line) => this.onLine(line));
    handle.exited.then(({ code }) => {
      for (const pending of this.pendingRpc.values()) pending.reject(new Error(stderr || `Codex App Server exited with code ${code}`));
      this.pendingRpc.clear();
      this.permissions.denyAll();
      this.setStatus('stopped');
      this.emit({ type: 'exit', participantId: this.descriptor.id, code });
    });
    await withTimeout(this.request('initialize', { clientInfo: { name: 'squirl', title: 'Squirl', version: '0.1.0' }, capabilities: { experimentalApi: true } }), 'Codex App Server did not initialize within 15 seconds. Upgrade the configured Codex binary.');
    this.write({ method: 'initialized', params: {} });
    const common = {
      cwd: this.descriptor.cwd,
      model: this.descriptor.model ?? null,
      approvalPolicy: this.descriptor.approvalPolicy ?? 'on-request',
      approvalsReviewer: 'user',
      sandbox: this.descriptor.sandbox ?? 'workspace-write',
    };
    const result = await withTimeout(this.descriptor.sessionId
      ? this.request('thread/resume', { ...common, threadId: this.descriptor.sessionId })
      : this.request('thread/start', common), 'Codex App Server did not start or resume a thread within 15 seconds.');
    const thread = object(result.thread);
    if (typeof thread.id === 'string') this.descriptor.sessionId = thread.id;
    if (!this.descriptor.sessionId) throw new Error('Codex App Server did not return a thread id. Upgrade the configured Codex binary.');
    this.setStatus('ready');
    this.emit({ type: 'session-status', participantId: this.descriptor.id, status: 'ready', sessionId: this.descriptor.sessionId, model: typeof result.model === 'string' ? result.model : this.descriptor.model });
  }

  async send(text: string): Promise<void> {
    if (!this.descriptor.sessionId) throw new Error(`Agent ${this.descriptor.id} has no Codex thread`);
    this.setStatus('busy');
    await this.request('turn/start', {
      threadId: this.descriptor.sessionId,
      input: [{ type: 'text', text }],
      cwd: this.descriptor.cwd,
      approvalPolicy: this.descriptor.approvalPolicy ?? 'on-request',
      approvalsReviewer: 'user',
      ...(this.descriptor.model ? { model: this.descriptor.model } : {}),
      ...(this.descriptor.effort ? { effort: this.descriptor.effort } : {}),
    });
  }

  async respondToInteraction(id: string, response: AgentInteractionResponse): Promise<void> {
    this.permissions.respond(id, response);
  }

  async interrupt(): Promise<void> {
    this.permissions.denyAll();
    if (this.descriptor.sessionId && this.turnId) await this.request('turn/interrupt', { threadId: this.descriptor.sessionId, turnId: this.turnId }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.interrupt();
    this.handle?.stdin.end();
    this.handle?.kill('SIGTERM');
    this.handle = null;
    this.setStatus('stopped');
  }
}
