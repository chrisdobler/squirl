import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent.js';

function render(markdown: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, null, markdown));
}

describe('MarkdownContent', () => {
  it('renders Markdown structure instead of literal Markdown text', () => {
    const html = render('**bold**\n\n- one\n- two\n\n`code`');

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>code</code>');
    expect(html).not.toContain('**bold**');
  });

  it('supports GitHub-flavored Markdown tables and task lists', () => {
    const html = render('| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done');

    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
  });

  it('renders JSON code fences as a collapsible viewer', () => {
    const html = render('```json\n{"name": "squirl", "ok": true}\n```');

    expect(html).toContain('jsonViewer');
    expect(html).toContain('<details');
    expect(html).toContain('squirl');
    expect(html).not.toContain('hljs-string');
  });

  it('renders json-l fences as a collapsible JSONL viewer', () => {
    const html = render('```json-l\n{"line": 1}\n{"line": 2}\n```');

    expect(html).toContain('jsonViewer');
    expect(html).toContain('Array(2)');
    expect(html).toContain('<summary');
  });
});
