import { describe, expect, it } from 'vitest';
import { parseMentions } from './mentions.js';

const known = ['squirl', 'cc', 'codex'];

describe('parseMentions', () => {
  it('returns no targets for bare text', () => {
    expect(parseMentions('build the feature', known)).toEqual({ targets: [], cleaned: 'build the feature' });
  });

  it('routes a leading mention and strips it from the prompt', () => {
    expect(parseMentions('@cc implement the adapter', known)).toEqual({ targets: ['cc'], cleaned: 'implement the adapter' });
  });

  it('supports multiple leading mentions, deduped and ordered', () => {
    expect(parseMentions('@cc @codex review this', known)).toEqual({ targets: ['cc', 'codex'], cleaned: 'review this' });
  });

  it('ignores unknown handles', () => {
    expect(parseMentions('@nobody hello @cc', known)).toEqual({ targets: ['cc'], cleaned: '@nobody hello @cc' });
  });

  it('matches mentions case-insensitively and returns the canonical id', () => {
    expect(parseMentions('@CC implement the adapter', known)).toEqual({ targets: ['cc'], cleaned: 'implement the adapter' });
    expect(parseMentions('@Codex run tests', known)).toEqual({ targets: ['codex'], cleaned: 'run tests' });
  });

  it('keeps mid-sentence mentions in the prompt but still routes them', () => {
    expect(parseMentions('ask @codex to run tests', known)).toEqual({ targets: ['codex'], cleaned: 'ask @codex to run tests' });
  });
});
