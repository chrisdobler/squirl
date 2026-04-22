import type { TurnPair, Embedder, VectorStore, EmbeddedChunk } from './types.js';
import type { StatusEmitter } from './status.js';

const BATCH_SIZE = 16;

export class IngestQueue {
  private queue: TurnPair[] = [];
  private processing = false;
  private drainScheduled = false;
  private readonly maxChars: number;

  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly status: StatusEmitter,
    maxTokens: number = 512,
  ) {
    // Conservative: ~2 chars per token for BERT tokenizers
    this.maxChars = Math.floor(maxTokens * 1.5);
  }

  enqueue(pair: TurnPair): void {
    this.queue.push(pair);
    if (!this.processing && !this.drainScheduled) {
      this.drainScheduled = true;
      queueMicrotask(() => {
        this.drainScheduled = false;
        this.drain();
      });
    }
  }

  async flush(): Promise<void> {
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      try {
        const texts = batch.map((p) => {
          let t = `${p.userText}\n${p.assistantText}`;
          if (p.toolSummary) t += `\n${p.toolSummary}`;
          return t.length > this.maxChars ? t.slice(0, this.maxChars) : t;
        });
        const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
        this.status.update({ phase: 'embedding', pending: batch.length + this.queue.length, batchSize: batch.length, chars: totalChars, maxChars: this.maxChars });
        const embeddings = await this.embedder.embed(texts);

        this.status.update({ phase: 'indexing', pending: batch.length + this.queue.length, batchSize: batch.length });
        const chunks: EmbeddedChunk[] = batch.map((turnPair, i) => ({
          turnPair, embedding: embeddings[i]!, text: texts[i]!,
        }));
        await this.store.upsert(chunks);
      } catch (err) {
        this.queue.unshift(...batch);
        this.status.update({
          phase: 'error', pending: this.queue.length,
          error: err instanceof Error ? err.message : String(err),
        });
        this.processing = false;
        return;
      }
    }

    this.status.update({ phase: 'idle', pending: 0 });
    this.processing = false;
  }
}
