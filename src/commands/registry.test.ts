import { describe, expect, it, vi } from 'vitest';
import { getCommands, matchCommand, type CommandContext } from './registry.js';
import type { RewindRequest } from '../rewind.js';
import type { Message } from '../types.js';

const user = (id: string, content: string): Message => ({ id, role: 'user', content });
const assistant = (id: string, content: string): Message => ({ id, role: 'assistant', content });

function ctx(messages: Message[], input: string): CommandContext & {
  outputs: Message[];
  rewinds: RewindRequest[];
  pickerOpened: boolean;
} {
  const outputs: Message[] = [];
  const rewinds: RewindRequest[] = [];
  let pickerOpened = false;
  return {
    orchestrator: {} as any,
    messages,
    workingDir: '/tmp',
    modelId: 'test',
    setMessages: vi.fn((fn: (prev: Message[]) => Message[]) => {
      outputs.splice(0, outputs.length, ...fn(outputs));
    }),
    openContextPicker: vi.fn(),
    commandInput: input,
    requestRewind: (request) => rewinds.push(request),
    openRewindPicker: () => { pickerOpened = true; },
    outputs,
    rewinds,
    get pickerOpened() { return pickerOpened; },
  };
}

describe('/rewind command', () => {
  it('opens picker mode with no arguments', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([user('u1', 'hello'), assistant('a1', 'hi')], '/rewind');

    command.execute(context);

    expect(context.pickerOpened).toBe(true);
    expect(context.outputs).toEqual([]);
    expect(context.rewinds).toEqual([]);
  });

  it('lists visible messages with stable numbers', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([user('u1', 'hello'), assistant('a1', 'hi')], '/rewind list');

    command.execute(context);

    expect(context.outputs[0]!.content).toContain('1. user');
    expect(context.outputs[0]!.content).toContain('2. assistant');
    expect(context.rewinds).toEqual([]);
  });

  it('requests removing the latest user turn for /rewind last', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([
      user('u1', 'keep'),
      assistant('a1', 'keep reply'),
      user('u2', 'dirty'),
      assistant('a2', 'dirty reply'),
    ], '/rewind last');

    command.execute(context);

    expect(context.rewinds).toEqual([expect.objectContaining({
      targetMessageId: 'a1',
      retainedCount: 2,
      removedCount: 2,
    })]);
  });

  it('supports clearing the first turn with /rewind last', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([user('u1', 'dirty'), assistant('a1', 'reply')], '/rewind last');

    command.execute(context);

    expect(context.rewinds).toEqual([expect.objectContaining({
      targetMessageId: null,
      retainedCount: 0,
      removedCount: 2,
    })]);
  });

  it('requests rewinding after the selected numbered message', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')], '/rewind 2');

    command.execute(context);

    expect(context.rewinds).toEqual([expect.objectContaining({
      targetMessageId: 'a1',
      retainedCount: 2,
      removedCount: 1,
    })]);
  });

  it('rejects invalid numbers', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([user('u1', 'one')], '/rewind 9');

    command.execute(context);

    expect(context.outputs[0]!.content).toContain('not in the current visible history');
    expect(context.rewinds).toEqual([]);
  });

  it('does nothing when the selected message is already last', () => {
    const command = matchCommand('/rewind')!;
    const context = ctx([user('u1', 'one')], '/rewind 1');

    command.execute(context);

    expect(context.outputs[0]!.content).toContain('nothing would be removed');
    expect(context.rewinds).toEqual([]);
  });
});

describe('/agent command', () => {
  it('adds PI with its provider model and full thinking vocabulary', async () => {
    const context = ctx([], '/agent add pi reviewer openai/gpt-test minimal');
    context.addAgent = vi.fn(async () => ({ ok: true as const, id: 'reviewer', label: 'reviewer' }));
    context.stopAgent = vi.fn();
    context.listAgents = vi.fn(() => []);
    await matchCommand(context.commandInput!)!.execute(context);
    expect(context.addAgent).toHaveBeenCalledWith('pi', { id: 'reviewer', model: 'openai/gpt-test', effort: 'minimal' });
  });

  it('renames an agent through the shared command callback', async () => {
    const context = ctx([], '/agent rename cc Claude Builder');
    context.addAgent = vi.fn();
    context.stopAgent = vi.fn();
    context.listAgents = vi.fn(() => []);
    context.renameAgent = vi.fn(async (_id: string, _name: string) => ({ ok: true as const, id: 'claude-builder', label: 'claude-builder' }));
    await matchCommand('/agent rename cc Claude Builder')!.execute(context);
    expect(context.renameAgent).toHaveBeenCalledWith('cc', 'Claude Builder');
    expect(context.outputs[0]!.content).toContain('@claude-builder');
  });
});

describe('modal command descriptors', () => {
  it('exposes direct web commands with usage and surfaces', () => {
    for (const name of ['settings', 'model', 'memory', 'eval', 'overview']) {
      expect(getCommands().find((command) => command.name === name)).toMatchObject({ name, usage: `/${name}`, surface: name });
    }
  });

  it('opens the promotional overview through the shared surface callback', () => {
    const open = vi.fn();
    const context = ctx([], '/overview');
    context.openCommandSurface = open;
    matchCommand('/overview')!.execute(context);
    expect(open).toHaveBeenCalledWith('overview');
  });

  it('keeps /setup as a settings alias and opens the shared surface', () => {
    const open = vi.fn();
    const context = ctx([], '/setup');
    context.openCommandSurface = open;
    matchCommand('/setup')!.execute(context);
    expect(open).toHaveBeenCalledWith('settings');
    expect(matchCommand('/models')?.name).toBe('model');
  });
});

describe('/scrum command', () => {
  it('defaults to yesterday and renders the generated report', async () => {
    const context = ctx([], '/scrum');
    context.generateScrum = vi.fn(async () => '# Scrum report');
    await matchCommand('/scrum')!.execute(context);
    expect(context.generateScrum).toHaveBeenCalledWith('');
    expect(context.outputs[0]).toMatchObject({ role: 'tool', toolName: '/scrum', content: '# Scrum report' });
  });

  it('passes natural dates and reports generator errors as command output', async () => {
    const context = ctx([], '/scrum monday');
    context.generateScrum = vi.fn(async () => { throw new Error('Scrum reports require semantic memory.'); });
    await matchCommand('/scrum monday')!.execute(context);
    expect(context.generateScrum).toHaveBeenCalledWith('monday');
    expect(context.outputs[0]!.content).toContain('require semantic memory');
  });

  it('exposes its palette template and usage', () => {
    expect(getCommands().find((command) => command.name === 'scrum')).toMatchObject({
      usage: '/scrum [yesterday|today|<weekday>|YYYY-MM-DD]',
      argumentTemplate: '/scrum yesterday',
    });
  });
});
