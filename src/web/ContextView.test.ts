import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContextSnapshot, ContextSnapshotSection } from './types.js';
import { ContextMatrix } from './ContextMatrix.js';
import { ContextAllocationHeadline, ContextSectionHeader, DroppedEvidenceNotice } from './ContextView.js';

function section(category: ContextSnapshotSection['category']): ContextSnapshotSection {
  return {
    id: 'message-0',
    label: category === 'memory' ? 'Recalled memory' : 'User message 1',
    role: 'user',
    category,
    content: 'body',
    start: 0,
    end: 4,
    metadataStart: null,
    metadataEnd: null,
    contentStart: 0,
    contentEnd: 4,
    approximateTokens: 5,
  };
}

describe('ContextSectionHeader', () => {
  it.each([
    ['system', 'system context'],
    ['memory', 'recalled memory context'],
    ['files', 'files context'],
    ['messages', 'messages context'],
  ] as const)('renders an accessible %s category pill', (category, accessibleLabel) => {
    const html = renderToStaticMarkup(React.createElement(ContextSectionHeader, { section: section(category) }));
    expect(html).toContain(`class="disc ${category} contextSectionDisc"`);
    expect(html).toContain(`aria-label="${accessibleLabel}"`);
    expect(html).toContain('class="contextSectionTitle"');
  });

  it('renders dropped web research as request-budget evidence, not request content', () => {
    const snapshot = {
      droppedEvidence: [{
        category: 'research', label: 'Web research', approximateTokens: 8_012,
        reason: 'exceeds-prompt-budget', traceStage: 'research-fetch',
      }],
    } as ContextSnapshot;
    const html = renderToStaticMarkup(React.createElement(DroppedEvidenceNotice, { snapshot }));

    expect(html).toContain('Dropped before request');
    expect(html).toContain('Web research');
    expect(html).toContain('~8k tokens');
    expect(html).toContain('data-trace-stage="research-fetch"');
  });

  it('gives response-reserve cells an accessible allocation label', () => {
    const html = renderToStaticMarkup(React.createElement(ContextMatrix, {
      cells: [{ index: 0, kind: 'response-reserve', disabled: true, title: 'Reserved for the model response', ariaLabel: 'Context position 1, reserved for model response' }],
      onSelect: () => {},
    }));

    expect(html).toContain('class="disc response-reserve"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Context position 1, reserved for model response"');
  });

  it('labels prompt capacity separately from the full window', () => {
    const snapshot = {
      approximateTokens: 3_959,
      promptBudgetTokens: 4_096,
      completionReserveTokens: 4_096,
      contextWindow: 8_192,
    } as ContextSnapshot;
    const html = renderToStaticMarkup(React.createElement(ContextAllocationHeadline, { snapshot }));

    expect(html).toBe('Prompt 4k / 4.1k · response reserve 4.1k · window 8.2k');
  });
});
