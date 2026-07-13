import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContextSnapshotSection } from './types.js';
import { ContextSectionHeader } from './ContextView.js';

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
});
