// Core contracts for "remoting in" headless coding agents (Claude Code, Codex) as
// group-chat participants. This module is UI-agnostic and Node-only; both the Ink TUI
// and the web/Electron runtime drive it.
//
// The central abstraction is AgentSession, which hides a large protocol asymmetry:
//   - Claude Code runs as ONE long-lived process with a streaming stdin (stream-json).
//   - Codex runs ONE process per turn, continued via `codex exec resume <id>`.
// Both present a uniform `send(text)` + event stream.

export type AgentKind = 'claude-code' | 'codex';
export type TransportKind = 'local' | 'ssh';

/** Lifecycle state of a single agent session. */
export type AgentStatus = 'starting' | 'ready' | 'busy' | 'stopped' | 'error';

/** Claude Code permission modes (subset we care about). */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** Codex sandbox policies. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Colors used to visually distinguish participants in both UIs. */
export type ParticipantColor = 'cyan' | 'green' | 'yellow' | 'magenta' | 'blue' | 'gray';

/** How a participant is configured. `id` doubles as the @mention handle. */
export interface AgentDescriptor {
  id: string;
  kind: AgentKind;
  label: string;
  transport: TransportKind;
  cwd: string;
  bin?: string;
  model?: string;
  /** Claude only. Defaults to 'default' (asks before edits/commands). */
  permissionMode?: ClaudePermissionMode;
  /** Claude only. Skip hooks/plugins/auto-memory. NOTE: breaks OAuth auth — opt-in for API-key users. */
  bare?: boolean;
  /** Codex only. Defaults to 'read-only'. */
  sandbox?: CodexSandbox;
  /** Resume target: a UUID for Claude (--session-id) or a Codex thread id (exec resume). */
  sessionId?: string;
  /** Future transport config; unused while transport === 'local'. */
  ssh?: { host: string; user?: string; identity?: string };
}

/** A chat participant: the user, squirl's local LLM, or a remote agent. */
export interface Participant {
  id: string;
  kind: 'user' | 'local-llm' | AgentKind;
  label: string;
  color: ParticipantColor;
  status?: AgentStatus;
  /** Short descriptor of the agent's permission/sandbox posture, for display. */
  mode?: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
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
  | { type: 'message-start'; participantId: string; messageId: string }
  | { type: 'token'; participantId: string; messageId: string; token: string }
  | { type: 'message-end'; participantId: string; messageId: string; content: string }
  | { type: 'tool-start'; participantId: string; toolId: string; toolName: string; input: unknown }
  | { type: 'tool-end'; participantId: string; toolId: string; toolName: string; result: string; ok: boolean }
  | { type: 'usage'; participantId: string; usage: AgentUsage }
  | { type: 'turn-end'; participantId: string }
  | { type: 'error'; participantId: string; message: string }
  | { type: 'exit'; participantId: string; code: number | null };

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
