import { execSync } from 'child_process';

export interface DirectoryContext {
  gitBranch: string | null;
  gitDirtyFiles: string[];
  recentCommits: string[];
  fileTree: string;
  gatheredAt: number;
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

export async function gatherDirectoryContext(cwd: string): Promise<DirectoryContext> {
  const gitBranch = run('git rev-parse --abbrev-ref HEAD', cwd) || null;

  const statusOutput = run('git status --porcelain', cwd);
  const gitDirtyFiles = statusOutput ? statusOutput.split('\n').filter(Boolean) : [];

  const logOutput = run('git log --oneline -5', cwd);
  const recentCommits = logOutput ? logOutput.split('\n').filter(Boolean) : [];

  // File tree: use git ls-files if in a repo, limit depth to 2 levels
  let fileTree = '';
  if (gitBranch) {
    const files = run('git ls-files', cwd);
    if (files) {
      const lines = files.split('\n').filter(Boolean);
      // Group by top 2 path segments for a compact tree
      const seen = new Set<string>();
      const limited: string[] = [];
      for (const f of lines) {
        const parts = f.split('/');
        const key = parts.slice(0, 2).join('/');
        if (!seen.has(key)) {
          seen.add(key);
          limited.push(parts.length > 2 ? key + '/' : key);
        }
        if (parts.length <= 2) {
          limited.push(f);
        }
      }
      // Deduplicate and sort
      fileTree = [...new Set(limited)].sort().join('\n');
    }
  }

  return {
    gitBranch,
    gitDirtyFiles,
    recentCommits,
    fileTree,
    gatheredAt: Date.now(),
  };
}

export function formatDirectoryContext(ctx: DirectoryContext): string {
  const sections: string[] = [];

  if (ctx.gitBranch) {
    sections.push(`Branch: ${ctx.gitBranch}`);
  }

  if (ctx.gitDirtyFiles.length > 0) {
    sections.push(`Dirty files:\n${ctx.gitDirtyFiles.join('\n')}`);
  }

  if (ctx.recentCommits.length > 0) {
    sections.push(`Recent commits:\n${ctx.recentCommits.join('\n')}`);
  }

  if (ctx.fileTree) {
    sections.push(`File tree:\n${ctx.fileTree}`);
  }

  return sections.join('\n\n');
}
