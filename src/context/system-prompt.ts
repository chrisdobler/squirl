import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

export interface SystemPromptVars {
  workingDir: string;
  date: string;
  modelId: string;
  platform: string;
  shell: string;
}

export function buildSystemPrompt(
  vars: SystemPromptVars,
  style: 'system' | 'developer',
): ChatCompletionMessageParam {
  const content = `You are Squirl, a CLI coding assistant running in the user's terminal.

Working directory: ${vars.workingDir}
Platform: ${vars.platform}
Shell: ${vars.shell}
Date: ${vars.date}
Model: ${vars.modelId}

You can read and write files, run shell commands, and list directory contents using the provided tools. Use tools proactively to gather information before answering questions about code.

Guidelines:
- Be concise and direct.
- When modifying files, show what you changed.
- When running commands, explain what you're doing and why.
- If a task is ambiguous, ask for clarification.
- Prefer reading files over guessing at their contents.`;

  return { role: style as 'system', content };
}
