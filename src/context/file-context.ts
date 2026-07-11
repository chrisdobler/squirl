import { readFileSync } from 'fs';
import { resolve } from 'path';

export function parseFileRefs(input: string, protectedHandles: string[] = []): { cleanedInput: string; filePaths: string[] } {
  const filePaths: string[] = [];
  const protectedSet = new Set(protectedHandles.map((handle) => handle.toLowerCase()));
  const cleanedInput = input.replace(/@([\w./\-]+)/g, (match, path: string) => {
    if (protectedSet.has(path.toLowerCase())) return match;
    filePaths.push(path);
    return path; // keep the filename in the message but strip the @
  });
  return { cleanedInput, filePaths };
}

export function readFileContent(
  filePath: string,
  cwd: string,
): { path: string; content: string } | { path: string; error: string } {
  const resolved = resolve(cwd, filePath);
  try {
    const content = readFileSync(resolved, 'utf-8');
    return { path: filePath, content };
  } catch (err) {
    return { path: filePath, error: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function formatFileContext(files: Map<string, string>): string {
  if (files.size === 0) return '';

  const sections: string[] = [];
  for (const [path, content] of files) {
    sections.push(`<file path="${path}">\n${content}\n</file>`);
  }
  return sections.join('\n\n');
}
