import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ToolDefinition } from './registry.js';

export const readFileTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory' },
        },
        required: ['path'],
      },
    },
  },
  execute: async (args, cwd) => {
    const filePath = resolve(cwd, args.path as string);
    try {
      return readFileSync(filePath, 'utf-8');
    } catch (err) {
      return `Error reading ${args.path}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
