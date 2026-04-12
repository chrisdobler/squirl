import type { Embedder } from '../types.js';
import OpenAI from 'openai';

type CreateFn = (params: { model: string; input: string[] }) => Promise<{ data: { index: number; embedding: number[] }[] }>;

interface Options {
  apiKey: string;
  model?: string;
  dimensions?: number;
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
      const client = new OpenAI({ apiKey: opts.apiKey });
      this.create = (params) => client.embeddings.create(params);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.create({ model: this.model, input: texts });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
