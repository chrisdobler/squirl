import type { ChatCompletionFunctionTool as ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { runCommandTool } from './run-command.js';
import { listFilesTool } from './list-files.js';
import { webFetchTool, webSearchTool } from './web-research.js';
import { statSync } from 'fs';
import { resolve } from 'path';
import type { WorkspaceToolName } from '../search/meta-extract.js';

export interface ToolDefinition {
  schema: ChatCompletionTool;
  execute: (args: Record<string, unknown>, cwd: string, context: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionContext {
  research?: { searxngUrl?: string; maxResults?: number };
}

const TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  runCommandTool,
  listFilesTool,
];

const RESEARCH_TOOLS: ToolDefinition[] = [webSearchTool, webFetchTool];

const toolMap = new Map<string, ToolDefinition>(
  [...TOOLS, ...RESEARCH_TOOLS].map((t) => [t.schema.function.name, t])
);

export function getToolDefinitions(options: { research?: boolean; allowedWorkspaceTools?: readonly WorkspaceToolName[] } = {}): ChatCompletionTool[] {
  const allowed = options.allowedWorkspaceTools ? new Set(options.allowedWorkspaceTools) : null;
  return [
    ...TOOLS.filter((tool) => !allowed || allowed.has(tool.schema.function.name as WorkspaceToolName)),
    ...(options.research ? RESEARCH_TOOLS : []),
  ].map((t) => t.schema);
}

export type ToolRejectionReason = 'not-allowed' | 'malformed-arguments' | 'invalid-arguments' | 'invalid-cwd';
export type ToolCallValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: ToolRejectionReason; summary: string; input: unknown };

function rejected(reason: ToolRejectionReason, summary: string, input: unknown): ToolCallValidation {
  return { ok: false, reason, summary, input };
}

/** Validate an emitted native call against the definitions offered for this turn. */
export function validateToolCall(
  name: string,
  rawArguments: string,
  allowedWorkspaceTools: readonly WorkspaceToolName[],
  defaultCwd: string,
): ToolCallValidation {
  if (!allowedWorkspaceTools.includes(name as WorkspaceToolName)) {
    return rejected('not-allowed', 'this turn did not request workspace execution', rawArguments.slice(0, 2_000));
  }
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch {
    return rejected('malformed-arguments', 'the model returned malformed JSON arguments', rawArguments.slice(0, 2_000));
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return rejected('invalid-arguments', 'tool arguments must be a JSON object', input);
  }
  const args = input as Record<string, unknown>;
  const requiredStrings: Record<string, string[]> = {
    read_file: ['path'], write_file: ['path', 'content'], run_command: ['command'], list_files: [],
  };
  const invalidRequired = (requiredStrings[name] ?? []).find((key) => typeof args[key] !== 'string' || (key !== 'content' && !(args[key] as string).trim()));
  if (invalidRequired) return rejected('invalid-arguments', `required argument ${invalidRequired} must be a${invalidRequired === 'content' ? '' : ' non-empty'} string`, input);
  if (name === 'list_files' && args.path !== undefined && typeof args.path !== 'string') {
    return rejected('invalid-arguments', 'optional argument path must be a string', input);
  }
  if (name === 'list_files' && args.depth !== undefined && (typeof args.depth !== 'number' || !Number.isFinite(args.depth))) {
    return rejected('invalid-arguments', 'optional argument depth must be a finite number', input);
  }
  if (name === 'run_command' && args.cwd !== undefined) {
    if (typeof args.cwd !== 'string' || !args.cwd.trim()) return rejected('invalid-cwd', 'working directory must be a non-empty string', input);
    try {
      if (!statSync(resolve(defaultCwd, args.cwd)).isDirectory()) return rejected('invalid-cwd', 'working directory does not exist or is not a directory', input);
    } catch {
      return rejected('invalid-cwd', 'working directory does not exist or is not a directory', input);
    }
  }
  return { ok: true, args };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  context: ToolExecutionContext = {},
): Promise<string> {
  const tool = toolMap.get(name);
  if (!tool) {
    return `Unknown tool: ${name}`;
  }
  return tool.execute(args, cwd, context);
}
