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
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  id: string;
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ModelConfig {
  id: string;
  contextWindow: number;
  supportsTools: boolean;
  systemPromptStyle: 'system' | 'developer';
}
