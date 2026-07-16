// Core contracts for "remoting in" headless coding agents (Claude Code, Codex, PI) as
// group-chat participants. This module is UI-agnostic and Node-only; both the Ink TUI
// and the web/Electron runtime drive it.
//
// The central abstraction is AgentSession, which hides a large protocol asymmetry:
//   - Claude Code runs as ONE long-lived process with a streaming stdin (stream-json).
//   - Codex runs ONE process per turn, continued via `codex exec resume <id>`.
// Both present a uniform `send(text)` + event stream.

import type { EffortLevel, ResponseMeta } from '../types.js';

export type AgentKind = 'claude-code' | 'codex' | 'pi';
export type TransportKind = 'local' | 'ssh';

export type PiToolMode = 'coding' | 'read-only';
export type PiApprovalMode = 'manual' | 'acceptEdits' | 'never';

/** Lifecycle state of a single agent session. */
export type AgentStatus = 'starting' | 'ready' | 'busy' | 'stopped' | 'error';

/** Claude Code permission modes (subset we care about). */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';

/** Codex sandbox policies. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'on-request' | 'untrusted' | 'never';

/** Colors used to visually distinguish participants in both UIs. */
export type ParticipantColor =
  | 'cyan'
  | 'magenta'
  | 'orange'
  | 'blue'
  | 'green'
  | 'red'
  | 'yellow'
  | 'gray'
  | 'teal'
  | 'violet'
  | 'brown';

/** How a participant is configured. `id` is its unique room handle. */
export interface AgentDescriptor {
  id: string;
  kind: AgentKind;
  label: string;
  /** Human-readable role used by Squirl when coordinating the room. */
  specialty?: string;
  transport: TransportKind;
  cwd: string;
  bin?: string;
  model?: string;
  effort?: EffortLevel;
  /** Claude only. Defaults to 'acceptEdits' (writes without edit prompts). */
  permissionMode?: ClaudePermissionMode;
  /** Claude only. Skip hooks/plugins/auto-memory. NOTE: breaks OAuth auth — opt-in for API-key users. */
  bare?: boolean;
  /** Codex only. Defaults to 'workspace-write'. */
  sandbox?: CodexSandbox;
  /** Codex only. Defaults to 'on-request'. */
  approvalPolicy?: CodexApprovalPolicy;
  /** PI only. Defaults to 'coding'; PI itself does not provide a sandbox or permission prompts. */
  piToolMode?: PiToolMode;
  /** PI only. Defaults to 'acceptEdits'. */
  piApprovalMode?: PiApprovalMode;
  /** Resume target: a Claude UUID, Codex thread id, or PI session id/path. */
  sessionId?: string;
  /** Future transport config; unused while transport === 'local'. */
  ssh?: { host: string; user?: string; identity?: string };
}

/** A chat participant: the user, squirl's local LLM, or a remote agent. */
export interface Participant {
  id: string;
  kind: 'user' | 'local-llm' | AgentKind;
  label: string;
  specialty?: string;
  color: ParticipantColor;
  status?: AgentStatus;
  /** Short descriptor of the agent's permission/sandbox posture, for display. */
  mode?: string;
  /** Working directory used when launching a remote CLI agent. */
  cwd?: string;
  /** Which surface currently owns the provider session. */
  controlMode?: 'headless' | 'terminal' | 'compacting';
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  contextWindow?: number;
}

/**
 * Unified event stream produced by every AgentSession. Deliberately parallels the
 * existing ChatCallbacks in src/orchestrator.ts so each event maps 1:1 onto the UI
 * machinery that already exists (onNewMessage / onToken / onToolStart / onToolEnd / onDone).
 *
 * A single agent "turn" produces: message-start, zero+ token, zero+ tool-start/tool-end,
 * message-end, usage, turn-end. The narrative text of a turn is coalesced into ONE
 * message (one messageId); tool activity is surfaced as separate tool-start/tool-end events.
 */
export type AgentEvent =
  | { type: 'session-status'; participantId: string; status: AgentStatus; sessionId?: string; model?: string; detail?: string }
  | { type: 'message-start'; participantId: string; messageId: string; responseMeta?: ResponseMeta }
  | { type: 'token'; participantId: string; messageId: string; token: string }
  | { type: 'message-end'; participantId: string; messageId: string; content: string }
  | { type: 'tool-start'; participantId: string; toolId: string; toolName: string; input: unknown }
  | { type: 'tool-end'; participantId: string; toolId: string; toolName: string; result: string; ok: boolean }
  | { type: 'usage'; participantId: string; usage: AgentUsage }
  | { type: 'turn-end'; participantId: string }
  | { type: 'error'; participantId: string; message: string }
  | { type: 'exit'; participantId: string; code: number | null }
  | { type: 'interaction-request'; participantId: string; request: AgentInteractionRequest }
  | { type: 'interaction-notify'; participantId: string; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'interaction-status'; participantId: string; key: string; text?: string }
  | { type: 'interaction-editor-prefill'; participantId: string; text: string }
  | {
      type: 'background-job'; participantId: string; state: 'started' | 'completed' | 'failed' | 'cancelled';
      taskId: string; runId?: string; workflowName?: string; summary?: string; transcriptDir?: string; workflowArgs?: string; error?: string;
    };

export type AgentInteractionRequest =
  | {
      id: string;
      method: 'permission';
      title: string;
      message?: string;
      toolName: string;
      input?: unknown;
      resource?: string;
      sessionScope?: { key: string; label: string };
    }
  | { id: string; method: 'select'; title?: string; message?: string; options: string[] }
  | { id: string; method: 'confirm'; title?: string; message?: string }
  | { id: string; method: 'input'; title?: string; message?: string; placeholder?: string }
  | { id: string; method: 'editor'; title?: string; message?: string; prefill?: string };

export interface AgentInteractionResponse {
  decision?: 'allow-once' | 'allow-session' | 'deny';
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** A live agent session. The caller cannot tell Claude (persistent) from Codex (per-turn) apart. */
export interface AgentSession {
  readonly descriptor: AgentDescriptor;
  readonly status: AgentStatus;
  /** Start the underlying transport/process. */
  start(): Promise<void>;
  /** Enqueue a user turn. Resolves when the turn is accepted (not when it completes). */
  send(text: string): Promise<void>;
  /** Cancel the in-flight turn, if any. */
  interrupt(): Promise<void>;
  /** Run provider-native context compaction when the headless protocol exposes it. */
  compact?(): Promise<void>;
  /** Reply to an agent-owned extension/UI request when the harness supports it. */
  respondToInteraction?(id: string, response: AgentInteractionResponse): Promise<void>;
  /** Consume one exact user-authorized tool call without opening a second permission prompt. */
  preapproveToolOnce?(toolName: string, input: Record<string, unknown>): boolean;
  /** Tear down the process/transport. */
  stop(): Promise<void>;
  /** Subscribe to the session's event stream. Returns an unsubscribe function. */
  onEvent(handler: (event: AgentEvent) => void): () => void;
}

/** A line-buffered handle to a spawned process, the seam where SSH later drops in. */
export interface SpawnHandle {
  stdin: NodeJS.WritableStream;
  /** stdout/stderr delivered as already line-split strings (no trailing newline). */
  onStdout(handler: (line: string) => void): void;
  onStderr(handler: (line: string) => void): void;
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** Abstracts "given an argv, give me a process with stdio". LocalSpawnTransport now; SshTransport later. */
export interface AgentTransport {
  readonly kind: TransportKind;
  spawn(spec: SpawnSpec): Promise<SpawnHandle>;
}

/** Injected into parsers so message ids are deterministic in tests. */
export interface ParserOptions {
  participantId: string;
  /** Returns a fresh synthetic message id for each turn's narrative message. */
  newMessageId: () => string;
}

/** A stateful stream parser: feed CLI stdout lines, collect AgentEvents. */
export interface StreamParser {
  /** Feed one stdout line; returns zero or more events. */
  push(line: string): AgentEvent[];
  /** Stream closed (process exit); flush any pending state. */
  end(code: number | null): AgentEvent[];
}
