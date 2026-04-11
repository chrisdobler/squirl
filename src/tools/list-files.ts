import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import type { ToolDefinition } from './registry.js';

function listWithGit(cwd: string): string | null {
  try {
    return execSync('git ls-files', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function listRecursive(dir: string, depth: number, maxDepth: number): string[] {
  if (depth >= maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const rel = entry.name;
      if (entry.isDirectory()) {
        results.push(rel + '/');
        const sub = listRecursive(join(dir, entry.name), depth + 1, maxDepth);
        results.push(...sub.map((s) => join(rel, s)));
      } else {
        results.push(rel);
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

export const listFilesTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory. Uses git ls-files when available, otherwise does a recursive listing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to working directory (default: ".")' },
          depth: { type: 'number', description: 'Maximum directory depth to recurse (default: 3)' },
        },
      },
    },
  },
  execute: async (args, cwd) => {
    const targetDir = args.path ? resolve(cwd, args.path as string) : cwd;
    const maxDepth = typeof args.depth === 'number' ? args.depth : 3;

    // Try git ls-files first
    const gitOutput = listWithGit(targetDir);
    if (gitOutput) {
      const lines = gitOutput.split('\n').filter(Boolean);
      // Filter by depth
      const filtered = lines.filter((line) => line.split('/').length <= maxDepth + 1);
      return filtered.join('\n') || '(no files)';
    }

    // Fallback to recursive listing
    const files = listRecursive(targetDir, 0, maxDepth);
    return files.join('\n') || '(no files)';
  },
};
