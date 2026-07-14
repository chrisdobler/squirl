import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PiModelOption {
  id: string;
  label: string;
  provider: string;
}

export interface PiModelDiscovery {
  models: PiModelOption[];
}

export function resolvePiBinary(configured?: string): string {
  return configured?.trim() || 'pi';
}

export function parsePiModelList(stdout: string): PiModelDiscovery {
  const models: PiModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [provider, model] = line.split(/\s+/, 2);
    if (!provider || !model || provider.toLowerCase() === 'provider') continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: model, provider });
  }
  return { models };
}

/** Ask the installed PI CLI for the providers/models available to its current auth configuration. */
export async function discoverPiModels(binary = 'pi', cwd = process.cwd(), timeoutMs = 10_000): Promise<PiModelDiscovery> {
  try {
    const { stdout } = await execFileAsync(binary, ['--list-models'], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return parsePiModelList(stdout);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') throw new Error(`PI executable not found: ${binary}. Install PI or set the PI binary in Settings.`);
    if (err.killed) throw new Error(`PI model discovery timed out after ${timeoutMs}ms.`);
    throw new Error(`Could not discover PI models: ${err.stderr?.trim() || err.message}`);
  }
}
