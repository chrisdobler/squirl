import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PresentationOverview } from './PresentationOverview.js';
import { createTurnPipelineTrace, finishTurnPipelineTrace, updateTurnPipelineTrace } from '../pipeline-trace.js';

const renderOverview = (mode: 'landing' | 'surface' = 'landing') => renderToStaticMarkup(
  React.createElement(PresentationOverview, { onStart: vi.fn(), mode }),
);

describe('PresentationOverview', () => {
  it('renders the intent-to-Squirl-to-agent story with accessible labels', () => {
    const html = renderOverview();

    expect(html).toContain('Your intent, orchestrated.');
    expect(html).toContain('Your mind');
    expect(html).toContain('Continuity + orchestration');
    expect(html).toContain('Squirl');
    expect(html).toContain('aria-label="Your mind and local AI infrastructure connect to Squirl as separate services');
    expect(html).toContain('Context orchestrator');
    expect(html).toContain('Chat model');
    expect(html).toContain('Embedder');
    expect(html).toContain('Vector database');
    expect(html).toContain('Local AI infrastructure');
    expect(html).toContain('vLLM');
    expect(html).toContain('Ollama');
    expect(html).toContain('OpenAI-compatible');
    expect(html).toContain('</footer></div><aside class="overviewLocalInfra"><span>Connected service</span><strong>Local AI infrastructure</strong>');
    expect(html).toContain('class="overviewServicePath"');
  });

  it('distinguishes available integrations from the extensible ecosystem', () => {
    const html = renderOverview('surface');

    expect(html.match(/Available now/g)).toHaveLength(3);
    expect(html.match(/Extensible/g)).toHaveLength(2);
    expect(html).toContain('Claude Code');
    expect(html).toContain('Codex');
    expect(html).toContain('PI Agent');
    expect(html).toContain('Connected integration');
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Custom agent');
    expect(html).toContain('presentationOverview--surface');
  });

  it('offers a focused start action', () => {
    const html = renderOverview();
    expect(html).toContain('>Start with an idea</span>');
    expect(html).toContain('<button type="button" class="overviewStart"');
  });

  it('renders the active trace and inspectable deterministic intent JSON', () => {
    const trace = updateTurnPipelineTrace(createTurnPipelineTrace('turn-1', 'Can I use a BIC card for EBT?'), {
      id: 'turn-intent', state: 'running', service: 'deterministic policy', input: { request: 'Can I use a BIC card for EBT?' },
    });
    const html = renderToStaticMarkup(React.createElement(PresentationOverview, { onStart: vi.fn(), mode: 'surface', trace }));
    expect(html).toContain('Inside this Squirl turn');
    expect(html).toContain('Deterministic turn intent');
    expect(html).toContain('deterministic policy');
    expect(html).toContain('Copy JSON');
    expect(html).toContain('&quot;request&quot;');
  });

  it('keeps raw request-routing output available in Inspect', () => {
    const trace = updateTurnPipelineTrace(createTurnPipelineTrace('turn-2', 'Answer this directly'), {
      id: 'action-plan', state: 'succeeded', service: 'routing model', output: { kind: 'none' },
    });
    const html = renderToStaticMarkup(React.createElement(PresentationOverview, { onStart: vi.fn(), mode: 'surface', trace }));
    expect(html).toContain('Request routing');
    expect(html).toContain('&quot;kind&quot;');
    expect(html).toContain('&quot;none&quot;');
  });

  it('labels a completed retained trace as saved execution with timestamps', () => {
    const trace = finishTurnPipelineTrace(createTurnPipelineTrace('turn-saved', 'Look back at this'), 'succeeded');
    const html = renderToStaticMarkup(React.createElement(PresentationOverview, { onStart: vi.fn(), mode: 'surface', trace }));
    expect(html).toContain('Saved execution');
    expect(html).toContain('traceOverall traceOverall--succeeded');
    expect(html).toContain('Started <time');
    expect(html).toContain('Finished <time');
  });
});
