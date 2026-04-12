import type { TurnPair, Embedder, VectorStore, EmbeddedChunk } from './types.js';
import type { StatusEmitter } from './status.js';

const BATCH_SIZE = 16;

export class IngestQueue {
  private queue: TurnPair[] = [];
  private processing = false;
  private drainScheduled = false;

  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly status: StatusEmitter,
  ) {}

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
        this.status.update({ phase: 'embedding', pending: batch.length + this.queue.length });
        const texts = batch.map((p) => {
          let t = `${p.userText}\n${p.assistantText}`;
          if (p.toolSummary) t += `\n${p.toolSummary}`;
          return t;
        });
        const embeddings = await this.embedder.embed(texts);

        this.status.update({ phase: 'indexing', pending: batch.length + this.queue.length });
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
