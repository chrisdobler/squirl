import { describe, expect, it } from 'vitest';
import {
  PASTE_COLLAPSE_CHAR_THRESHOLD,
  PASTE_COLLAPSE_LINE_THRESHOLD,
  shouldCollapsePasteRegion,
} from './ChatInput.js';

describe('shouldCollapsePasteRegion', () => {
  it('keeps normal voice-control sized paste chunks visible', () => {
    const pastedText = 'dictated sentence '.repeat(40);

    expect(shouldCollapsePasteRegion(pastedText, { start: 0, length: pastedText.length })).toBe(false);
  });

  it('collapses very large paste chunks', () => {
    const pastedText = 'x'.repeat(PASTE_COLLAPSE_CHAR_THRESHOLD + 1);

    expect(shouldCollapsePasteRegion(pastedText, { start: 0, length: pastedText.length })).toBe(true);
  });

  it('collapses paste chunks with too many lines', () => {
    const pastedText = Array.from({ length: PASTE_COLLAPSE_LINE_THRESHOLD + 1 }, (_, index) => `line ${index}`).join('\n');

    expect(shouldCollapsePasteRegion(pastedText, { start: 0, length: pastedText.length })).toBe(true);
  });

  it('does not collapse missing or stale paste regions', () => {
    expect(shouldCollapsePasteRegion('hello', null)).toBe(false);
    expect(shouldCollapsePasteRegion('hello', { start: -1, length: 3 })).toBe(false);
    expect(shouldCollapsePasteRegion('hello', { start: 3, length: 99 })).toBe(false);
  });
});
