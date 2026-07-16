import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolActivityView } from './ToolActivityView.js';

describe('ToolActivityView', () => {
  it('is collapsed by default and exposes an accessible structured summary', () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityView, { message: {
      id: 't1', role: 'tool', toolCallId: 'call', toolName: 'cc:Read', content: 'contents',
      toolInput: { file_path: 'src/app.tsx' }, toolStatus: 'success', participantId: 'cc',
    } }));
    expect(html).toContain('<details class="toolActivity">');
    expect(html).not.toContain('<details class="toolActivity" open=""');
    expect(html).toContain('Read src/app.tsx; completed');
    expect(html).toContain('<h4>Input</h4>');
    expect(html).toContain('<h4>Output</h4>');
  });

  it('marks failed activity without expanding or losing its output', () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityView, { message: {
      id: 't2', role: 'tool', toolCallId: 'call', toolName: 'command_execution', content: 'exit 1',
      toolInput: { command: 'false' }, toolStatus: 'error',
    } }));
    expect(html).toContain('toolActivity failed');
    expect(html).not.toContain('<details class="toolActivity failed" open=""');
    expect(html).toContain('Run false; failed');
    expect(html).toContain('exit 1');
  });

  it('renders a policy rejection as one compact, non-expandable row', () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityView, { message: {
      id: 't3', role: 'tool', toolCallId: 'call', toolName: 'run_command', content: '{"ok":false}',
      toolInput: '{"command":"ebt balance"}', toolStatus: 'error',
      toolRejection: { reason: 'not-allowed', summary: 'this turn did not request workspace execution' },
    } }));
    expect(html).toContain('Run Command rejected — this turn did not request workspace execution');
    expect(html).toContain('class="toolActivity toolRejected"');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('ebt balance');
  });
});
