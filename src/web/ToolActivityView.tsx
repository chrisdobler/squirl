import React from 'react';
import type { Message } from '../types.js';
import { toolActivitySummary } from '../tool-activity.js';

export function ToolActivityView({ message }: { message: Extract<Message, { role: 'tool' }> }) {
  const running = message.toolStatus === 'running';
  const failed = message.toolStatus === 'error';
  const input = message.toolInput === undefined ? '' : JSON.stringify(message.toolInput, null, 2);
  const summary = toolActivitySummary(message);
  if (message.toolRejection) {
    const label = `${summary} rejected — ${message.toolRejection.summary}`;
    return <div className="toolActivity toolRejected" role="status" aria-label={label}>
      <span className="toolState" aria-hidden="true">⊘</span>
      <span className="toolSummary">{label}</span>
      <span className="toolResultState">rejected</span>
    </div>;
  }
  return <details className={`toolActivity${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
    <summary aria-label={`${summary}; ${running ? 'running' : failed ? 'failed' : 'completed'}`}>
      <span className="toolChevron" aria-hidden="true"/>
      <span className="toolState" aria-hidden="true">{running ? '●' : failed ? '✕' : '✓'}</span>
      <span className="toolSummary">{summary}</span>
      <span className="toolResultState">{running ? 'running' : failed ? 'failed' : 'done'}</span>
    </summary>
    {!running && <div className="toolDetails">
      {input && <section><h4>Input</h4><pre>{input}</pre></section>}
      <section><h4>Output{message.outputTruncated ? ' · truncated' : ''}</h4><pre>{message.content || '(no output)'}</pre></section>
    </div>}
  </details>;
}
