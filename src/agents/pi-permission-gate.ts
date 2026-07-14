import { resolve } from 'node:path';
interface PiToolCallEvent { toolName: string; input?: unknown }
interface PiToolCallContext {
  cwd: string;
  hasUI: boolean;
  ui: { select(title: string, options: string[]): Promise<string | undefined> };
}
interface ExtensionAPI {
  on(event: 'tool_call', handler: (event: PiToolCallEvent, context: PiToolCallContext) => Promise<{ block: true; reason: string } | undefined>): void;
}

const ALLOW_ONCE = 'Allow once';
const DENY = 'Deny';
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const EDIT_TOOLS = new Set(['edit', 'write']);

function stable(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
}

function preview(value: unknown): string {
  const text = stable(value);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

function permission(toolName: string, input: Record<string, unknown>, cwd: string): { resource?: string; key?: string; label?: string } {
  if (EDIT_TOOLS.has(toolName)) {
    const raw = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
    if (!raw) return {};
    const path = resolve(cwd, raw);
    return { resource: path, key: `${toolName}:${path}`, label: `Always allow this file for this session` };
  }
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command.trim().replace(/\s+/g, ' ') : '';
    if (!command) return {};
    return { resource: command, key: `bash:${command}`, label: 'Always allow this exact command for this session' };
  }
  const serialized = stable(input);
  if (serialized.length > 1000) return {};
  return { resource: serialized, key: `${toolName}:${serialized}`, label: `Always allow this ${toolName} request for this session` };
}

export default function permissionGate(pi: ExtensionAPI) {
  const grants = new Set<string>();
  pi.on('tool_call', async (event, ctx) => {
    const mode = process.env.SQUIRL_PI_APPROVAL_MODE ?? 'acceptEdits';
    if (mode === 'never' || READ_TOOLS.has(event.toolName) || (mode === 'acceptEdits' && EDIT_TOOLS.has(event.toolName))) return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const scope = permission(event.toolName, input, ctx.cwd);
    if (scope.key && grants.has(scope.key)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: 'Permission denied because no interactive Squirl client is available.' };

    const metadata = {
      toolName: event.toolName,
      input: preview(input),
      resource: scope.resource,
      sessionScope: scope.key && scope.label ? { key: scope.key, label: scope.label } : undefined,
    };
    const options = [ALLOW_ONCE, ...(scope.key ? [scope.label!] : []), DENY];
    const choice = await ctx.ui.select(`SQUIRL_PERMISSION:${JSON.stringify(metadata)}`, options);
    if (choice === scope.label && scope.key) grants.add(scope.key);
    if (choice !== ALLOW_ONCE && choice !== scope.label) return { block: true, reason: 'Denied by the user in Squirl.' };
    return undefined;
  });
}
