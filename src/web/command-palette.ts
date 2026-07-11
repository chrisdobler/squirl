import type { CommandDescriptor, CommandSurface } from '../commands/registry.js';

const SURFACES: Partial<Record<string, CommandSurface>> = {
  setup: 'settings', settings: 'settings', model: 'model', models: 'model', context: 'context',
  memory: 'memory', eval: 'eval', rewind: 'rewind', room: 'room', agents: 'room', agent: 'agent',
  system: 'system', help: 'help',
};

export function filterCommandPalette(commands: CommandDescriptor[], input: string): CommandDescriptor[] {
  const needle = input.replace(/^\//, '').toLowerCase();
  return commands.filter((command) =>
    command.name.includes(needle)
    || command.aliases?.some((alias) => alias.includes(needle))
    || command.description.toLowerCase().includes(needle),
  );
}

export function commandSelectionValue(command: CommandDescriptor): string | null {
  if (resolveCommandSurface(command)) return null;
  return command.argumentTemplate ?? (command.usage ?? `/${command.name}`).replace(/<[^>]+>/g, '').trimEnd();
}

export function shouldShowCommandPalette(input: string): boolean {
  return /^\/[^\s]*$/.test(input);
}

export function resolveCommandSurface(command: CommandDescriptor): CommandSurface | undefined {
  return command.surface ?? SURFACES[command.name];
}

export function moveCommandSelection(current: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}
