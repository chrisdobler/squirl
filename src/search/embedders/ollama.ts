import type { Embedder } from '../types.js';
import { searchLog } from '../debug.js';

type FetchFn = typeof globalThis.fetch;

interface Options {
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetchFn?: FetchFn;
}

export class OllamaEmbedder implements Embedder {
  readonly name: string;
  readonly dimensions: number;
  private readonly model: string;
  private readonly url: string;
  private readonly fetch: FetchFn;

  constructor(opts: Options = {}) {
    this.model = opts.model ?? 'nomic-embed-text';
    this.dimensions = opts.dimensions ?? 768;
    this.name = `ollama:${this.model}`;
    this.url = (opts.baseUrl ?? 'http://localhost:11434') + '/api/embed';
    this.fetch = opts.fetchFn ?? globalThis.fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    searchLog('OLLAMA EMBED REQUEST', { model: this.model, url: this.url, texts: texts.length, chars: texts.map(t => t.length) });
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text();
      searchLog('OLLAMA EMBED ERROR', { status: res.status, body });
      throw new Error(`Ollama embed failed (${res.status}): ${body}`);
    }
    const json = await res.json() as { embeddings: number[][] };
    searchLog('OLLAMA EMBED RESPONSE', json.embeddings.map((e, i) => ({ index: i, dims: e.length, head: e.slice(0, 5).map(v => v.toFixed(4)) })));
    return json.embeddings;
  }
}
