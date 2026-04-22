import type { Embedder } from '../types.js';
import OpenAI from 'openai';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
    if (process.env.SQUIRL_DEBUG) {
      const logPath = join(homedir(), '.squirl', 'embedder.log');
      appendFileSync(logPath, `[${new Date().toISOString()}] REQUEST ${JSON.stringify(params, null, 2)}\n`);
    }
    try {
      const res = await this.create(params);
      if (process.env.SQUIRL_DEBUG) {
        const logPath = join(homedir(), '.squirl', 'embedder.log');
        const summary = res.data.map(d => ({ index: d.index, dims: d.embedding.length }));
        appendFileSync(logPath, `[${new Date().toISOString()}] RESPONSE ${JSON.stringify(summary)}\n`);
      }
      return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      if (process.env.SQUIRL_DEBUG) {
        const logPath = join(homedir(), '.squirl', 'embedder.log');
        appendFileSync(logPath, `[${new Date().toISOString()}] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
      }
      throw err;
    }
  }
}
