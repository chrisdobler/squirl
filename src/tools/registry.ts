import type { ChatCompletionFunctionTool as ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { runCommandTool } from './run-command.js';
import { listFilesTool } from './list-files.js';

export interface ToolDefinition {
  schema: ChatCompletionTool;
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

const TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  runCommandTool,
  listFilesTool,
];

const toolMap = new Map<string, ToolDefinition>(
  TOOLS.map((t) => [t.schema.function.name, t])
);

export function getToolDefinitions(): ChatCompletionTool[] {
  return TOOLS.map((t) => t.schema);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const tool = toolMap.get(name);
  if (!tool) {
    return `Unknown tool: ${name}`;
  }
  return tool.execute(args, cwd);
}
