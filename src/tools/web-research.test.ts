import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeTool, getToolDefinitions } from './registry.js';
import { assertSafePublicUrl, extractReadableText, isBlockedAddress, normalizeSearxResponse, researchMetadataFromToolResult } from './web-research.js';

afterEach(() => vi.unstubAllGlobals());

describe('web research tools', () => {
  it('exposes research tools only when enabled by the orchestrator', () => {
    expect(getToolDefinitions().map((tool) => tool.function.name)).not.toContain('web_search');
    expect(getToolDefinitions({ research: true }).map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
  });

  it('normalizes and bounds SearXNG results', () => {
    const normalized = normalizeSearxResponse({ results: [
      { title: 'Official source', url: 'https://agency.gov/answer', content: 'Current guidance', publishedDate: '2026-07-15', engines: ['google'] },
      { title: 'Unsafe', url: 'file:///etc/passwd' },
      { title: 'Second', url: 'https://example.org/two', content: 'Two' },
    ] }, 'benefit card guidance', 1);
    expect(normalized).toEqual({ kind: 'web_search', query: 'benefit card guidance', results: [{
      title: 'Official source', url: 'https://agency.gov/answer', domain: 'agency.gov', snippet: 'Current guidance', publishedAt: '2026-07-15', engines: ['google'],
    }] });
  });

  it('extracts readable text while dropping executable and styled content', () => {
    const result = extractReadableText('<html><head><title>A &amp; B</title><style>.x{}</style></head><body><main><h1>Answer</h1><script>ignore me</script><p>Use the separate card&nbsp;today.</p></main></body></html>');
    expect(result.title).toBe('A & B');
    expect(result.text).toContain('Answer');
    expect(result.text).toContain('Use the separate card today.');
    expect(result.text).not.toContain('ignore me');
  });

  it.each(['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.168.1.10', '::1', 'fd00::1', 'fe80::1'])(
    'blocks local or private address %s', (address) => expect(isBlockedAddress(address)).toBe(true),
  );

  it('rejects unsafe URL schemes and private literal targets', async () => {
    await expect(assertSafePublicUrl('file:///etc/passwd')).rejects.toThrow('Only HTTP and HTTPS');
    await expect(assertSafePublicUrl('http://127.0.0.1/private')).rejects.toThrow('blocked');
  });

  it('searches configured SearXNG JSON and records bounded provenance', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: 'Agency', url: 'https://agency.gov/page', content: 'Guidance' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeTool('web_search', { query: 'current guidance' }, '/repo', { research: { searxngUrl: 'http://searxng:8080', maxResults: 5 } });
    const requested = String((fetchMock.mock.calls as unknown as Array<unknown[]>)[0]?.[0]);
    expect(requested).toContain('q=current+guidance');
    expect(requested).toContain('format=json');
    expect(researchMetadataFromToolResult('web_search', result)).toEqual({
      kind: 'search', query: 'current guidance', sources: [{ title: 'Agency', url: 'https://agency.gov/page', domain: 'agency.gov' }],
    });
  });

  it('reports the SearXNG JSON-format configuration failure clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(executeTool('web_search', { query: 'test' }, '/repo', { research: { searxngUrl: 'http://searxng:8080' } }))
      .resolves.toContain('enable JSON in search.formats');
  });

  it('fetches bounded public HTML and marks the source as fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<title>Official</title><main><p>Supported fact.</p></main>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    })));
    const result = await executeTool('web_fetch', { url: 'https://93.184.216.34/page' }, '/repo');
    expect(result).toContain('Supported fact.');
    expect(researchMetadataFromToolResult('web_fetch', result)).toEqual({
      kind: 'fetch', sources: [{ title: 'Official', url: 'https://93.184.216.34/page', domain: '93.184.216.34', fetched: true }],
    });
  });

  it('blocks a redirect from a public page to a private target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } })));
    await expect(executeTool('web_fetch', { url: 'https://93.184.216.34/start' }, '/repo')).resolves.toContain('blocked');
  });
});
