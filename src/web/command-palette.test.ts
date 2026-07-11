import { describe, expect, it } from 'vitest';
import { commandSelectionValue, filterCommandPalette, moveCommandSelection, resolveCommandSurface, shouldShowCommandPalette } from './command-palette.js';
import type { CommandDescriptor } from '../commands/registry.js';

const commands: CommandDescriptor[] = [
  { name: 'settings', aliases: ['setup'], description: 'Guided configuration', usage: '/settings', surface: 'settings' },
  { name: 'recall', description: 'Search memory', usage: '/recall <query>', argumentTemplate: '/recall ' },
];

describe('web command palette', () => {
  it('filters by canonical name, alias, and description', () => {
    expect(filterCommandPalette(commands, '/set').map((c) => c.name)).toEqual(['settings']);
    expect(filterCommandPalette(commands, '/setup').map((c) => c.name)).toEqual(['settings']);
    expect(filterCommandPalette(commands, '/memory').map((c) => c.name)).toEqual(['recall']);
  });

  it('opens surfaces directly and inserts templates for argument commands', () => {
    expect(commandSelectionValue(commands[0]!)).toBeNull();
    expect(commandSelectionValue(commands[1]!)).toBe('/recall ');
  });

  it('suggests while completing a command name, then yields to argument entry', () => {
    expect(shouldShowCommandPalette('/')).toBe(true);
    expect(shouldShowCommandPalette('/set')).toBe(true);
    expect(shouldShowCommandPalette('/recall ')).toBe(false);
    expect(shouldShowCommandPalette('/recall project')).toBe(false);
  });

  it('opens known surfaces from descriptors served by an older runtime', () => {
    const legacy = { name: 'context', description: 'Manage context' } as CommandDescriptor;
    expect(resolveCommandSurface(legacy)).toBe('context');
    expect(commandSelectionValue(legacy)).toBeNull();
  });

  it('wraps arrow navigation through the filtered matches', () => {
    expect(moveCommandSelection(0, -1, 4)).toBe(3);
    expect(moveCommandSelection(3, 1, 4)).toBe(0);
    expect(moveCommandSelection(1, 1, 4)).toBe(2);
  });
});
