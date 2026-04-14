import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { SelectedModel } from './components/ModelPicker.js';
import type { Message, AssistantMessage, ToolCall } from './types.js';
import { getModelConfig } from './model-config.js';
import { buildSystemPrompt } from './context/system-prompt.js';
import { gatherDirectoryContext, formatDirectoryContext } from './context/directory-context.js';
import type { DirectoryContext } from './context/directory-context.js';
import { parseFileRefs, readFileContent, formatFileContext } from './context/file-context.js';
import { truncateToFit } from './context/truncation.js';
import { getToolDefinitions, executeTool } from './tools/registry.js';
import { streamChatCompletion } from './api.js';
import { platform } from 'os';
import type { MemoryPipeline } from './search/memory-pipeline.js';

export interface ChatCallbacks {
  onToken: (token: string) => void;
  onDone: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
  onError: (error: Error) => void;
  onNewMessage?: (message: Message) => void;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string, result: string) => void;
  onMemoryStart?: () => void;
  onMemoryEnd?: (inlineDisplay: string) => void;
}

const MAX_TOOL_ITERATIONS = 10;
const DIR_CONTEXT_TTL = 30_000;

export class Orchestrator {
  private contextFiles = new Map<string, string>();
  private cachedDirContext: DirectoryContext | null = null;
  private workingDir: string;
  private memoryPipeline: MemoryPipeline | null = null;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  setMemoryPipeline(pipeline: MemoryPipeline | null): void {
    this.memoryPipeline = pipeline;
  }

  async chat(
    userInput: string,
    conversationHistory: Message[],
    model: SelectedModel,
    callbacks: ChatCallbacks,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const newMessages: Message[] = [];

    // 1. Parse @file references
    const { cleanedInput, filePaths } = parseFileRefs(userInput);
    for (const fp of filePaths) {
      const result = readFileContent(fp, this.workingDir);
      if ('content' in result) {
        this.contextFiles.set(result.path, result.content);
      }
    }

    // 2. Create user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: cleanedInput,
    };
    newMessages.push(userMsg);
    callbacks.onNewMessage?.(userMsg);

    // 3. Refresh directory context if stale
    if (!this.cachedDirContext || Date.now() - this.cachedDirContext.gatheredAt > DIR_CONTEXT_TTL) {
      this.cachedDirContext = await gatherDirectoryContext(this.workingDir);
    }

    // 4. Get model config
    const config = getModelConfig(model.id);

    // 5. Build system messages
    const systemPrompt = buildSystemPrompt(
      {
        workingDir: this.workingDir,
        date: new Date().toISOString().slice(0, 10),
        modelId: model.id,
        platform: platform(),
        shell: process.env.SHELL ?? 'unknown',
      },
      config.systemPromptStyle,
    );

    const dirContextText = formatDirectoryContext(this.cachedDirContext);
    const systemMessages: ChatCompletionMessageParam[] = [systemPrompt];
    if (dirContextText) {
      systemMessages.push({ role: 'system', content: `Project context:\n${dirContextText}` });
    }

    // 6. File context
    const fileText = formatFileContext(this.contextFiles);
    const fileContextMessage: ChatCompletionMessageParam | null = fileText
      ? { role: 'system', content: `Files in context:\n${fileText}` }
      : null;

    // 6b. Memory retrieval
    let memoryMessage: ChatCompletionMessageParam | null = null;
    if (this.memoryPipeline) {
      callbacks.onMemoryStart?.();
      try {
        const memResult = await this.memoryPipeline.retrieve(conversationHistory, cleanedInput);
        if (memResult.systemMessage) {
          memoryMessage = { role: 'system', content: memResult.systemMessage };
        }
        callbacks.onMemoryEnd?.(memResult.inlineDisplay);
      } catch {
        callbacks.onMemoryEnd?.('');
      }
    }

    // 7. Convert conversation history to API format
    const allMessages = [...conversationHistory, userMsg];
    const conversationApiMessages = this.toApiMessages(allMessages);

    // 8. Truncate to fit
    const allSystemMessages = [...systemMessages];
    if (fileContextMessage) allSystemMessages.push(fileContextMessage);
    if (memoryMessage) allSystemMessages.push(memoryMessage);

    const { messages: truncatedMessages } = truncateToFit(
      allSystemMessages,
      null,
      conversationApiMessages,
      config.contextWindow,
    );

    // 9. Tool definitions
    const tools = config.supportsTools ? getToolDefinitions() : undefined;

    // 10. Stream + tool call loop
    let apiMessages = truncatedMessages;
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const assistantId = crypto.randomUUID();
      const assistantMsg: AssistantMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        isStreaming: true,
      };
      newMessages.push(assistantMsg);
      callbacks.onNewMessage?.(assistantMsg);

      let accumulatedContent = '';
      let receivedToolCalls: ToolCall[] | null = null;

      await new Promise<void>((resolve, reject) => {
        streamChatCompletion({
          messages: apiMessages,
          model,
          tools,
          onToken: (token) => {
            accumulatedContent += token;
            assistantMsg.content = accumulatedContent;
            callbacks.onToken(token);
          },
          onToolCalls: (toolCalls) => {
            receivedToolCalls = toolCalls;
            assistantMsg.toolCalls = toolCalls;
          },
          onDone: (usage) => {
            assistantMsg.isStreaming = false;
            callbacks.onDone(usage);
            resolve();
          },
          onError: (error) => {
            assistantMsg.isStreaming = false;
            assistantMsg.content = `Error: ${error.message}`;
            callbacks.onError(error);
            resolve(); // resolve, not reject — error is handled via callback
          },
          signal,
        });
      });

      // If no tool calls, we're done
      const toolCalls: ToolCall[] = receivedToolCalls ?? [];
      if (toolCalls.length === 0) {
        break;
      }
      const assistantApiMsg: ChatCompletionMessageParam = {
        role: 'assistant',
        content: accumulatedContent || null,
        tool_calls: toolCalls.map((tc: ToolCall) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };

      apiMessages = [...apiMessages, assistantApiMsg];

      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.arguments); } catch { /* use empty */ }

        callbacks.onToolStart?.(tc.name, args);
        const result = await executeTool(tc.name, args, this.workingDir);
        callbacks.onToolEnd?.(tc.name, result);

        const toolMsg: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: result,
        };
        newMessages.push(toolMsg);
        callbacks.onNewMessage?.(toolMsg);

        apiMessages = [...apiMessages, {
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: result,
        }];
      }
    }

    return newMessages;
  }

  private toApiMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((m): ChatCompletionMessageParam => {
      switch (m.role) {
        case 'user':
          return { role: 'user', content: m.content };
        case 'assistant': {
          if (m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            };
          }
          return { role: 'assistant', content: m.content || null };
        }
        case 'tool':
          return { role: 'tool' as const, tool_call_id: m.toolCallId, content: m.content };
      }
    });
  }

  getContextFiles(): Map<string, string> {
    return new Map(this.contextFiles);
  }

  addContextFile(path: string): void {
    const result = readFileContent(path, this.workingDir);
    if ('content' in result) {
      this.contextFiles.set(result.path, result.content);
    }
  }

  removeContextFile(path: string): void {
    this.contextFiles.delete(path);
  }

  clearContextFiles(): void {
    this.contextFiles.clear();
  }
}
