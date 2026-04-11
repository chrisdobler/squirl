import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ToolDefinition } from './registry.js';

export const writeFileTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  execute: async (args, cwd) => {
    const filePath = resolve(cwd, args.path as string);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, args.content as string, 'utf-8');
      return `Successfully wrote ${args.path}`;
    } catch (err) {
      return `Error writing ${args.path}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
