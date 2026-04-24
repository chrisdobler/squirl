import type { Embedder } from '../types.js';
import OpenAI from 'openai';
import { searchLog } from '../debug.js';

type CreateFn = (params: { model: string; input: string[] }) => Promise<{ data: { index: number; embedding: number[] }[] }>;

interface Options {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  createFn?: CreateFn;
}

export class OpenAIEmbedder implements Embedder {
  readonly name: string;
  readonly dimensions: number;
  private readonly create: CreateFn;
  private readonly model: string;

  constructor(opts: Options) {
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
    this.name = `openai:${this.model}`;
    if (opts.createFn) {
      this.create = opts.createFn;
    } else {
      const client = new OpenAI({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
      this.create = (params) => client.embeddings.create(params);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const params = { model: this.model, input: texts };
    searchLog('EMBED REQUEST', { model: this.model, texts: texts.length, chars: texts.map(t => t.length) });
    try {
      const res = await this.create(params);
      searchLog('EMBED RESPONSE', res.data.map(d => ({ index: d.index, dims: d.embedding.length, head: d.embedding.slice(0, 5).map(v => v.toFixed(4)) })));
      return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      searchLog('EMBED ERROR', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
