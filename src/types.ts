export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  /** Which agent the user addressed, if any. Undefined = the default chat. */
  participantId?: string;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  /** Authoring participant. Undefined = squirl's local LLM; otherwise a remote agent id. */
  participantId?: string;
}

export interface ToolMessage {
  id: string;
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  /** Owning participant for tool activity surfaced from a remote agent. */
  participantId?: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ModelConfig {
  id: string;
  contextWindow: number;
  supportsTools: boolean;
  systemPromptStyle: 'system' | 'developer';
}
