import type { Embedder } from './types.js';
import { memoryEmbeddingText, MEMORY_PREVIEW_MAX_CHARS, type MemoryVectorIndex } from './memory-chunks.js';
import type { RoomStore } from '../persistence/types.js';

const BATCH_SIZE = 16;

export type MemoryIndexWorkerErrorStage = 'claim' | 'process' | 'persist-result';

export class MemoryIndexWorker {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: RoomStore,
    private readonly embedder: Embedder,
    private readonly index: MemoryVectorIndex,
    private readonly onError: (error: unknown, stage: MemoryIndexWorkerErrorStage) => void = () => undefined,
  ) {}

  private reportError(error: unknown, stage: MemoryIndexWorkerErrorStage): void {
    try { this.onError(error, stage); } catch { /* Error reporting must not stop future drains. */ }
  }

  private triggerDrain(): void {
    // drain contains expected dependency failures. Keep this final observer as
    // defense in depth so a future unexpected rejection cannot terminate Node.
    void this.drain().catch((error) => this.reportError(error, 'claim'));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.triggerDrain(), 10_000);
    this.timer.unref?.();
    this.triggerDrain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        let chunks: Awaited<ReturnType<RoomStore['claimMemoryChunks']>>;
        try {
          chunks = await this.repository.claimMemoryChunks(BATCH_SIZE);
        } catch (error) {
          this.reportError(error, 'claim');
          break;
        }
        if (chunks.length === 0) break;
        try {
          const embeddings = await this.embedder.embed(chunks.map(memoryEmbeddingText));
          await this.index.upsert(chunks.map((chunk, index) => ({
            chunk, embedding: embeddings[index]!, preview: chunk.content.slice(0, MEMORY_PREVIEW_MAX_CHARS),
          })));
        } catch (error) {
          this.reportError(error, 'process');
          try {
            await this.repository.markMemoryChunksFailed(chunks.map((chunk) => chunk.id), error instanceof Error ? error.message : String(error));
          } catch (persistError) {
            // Keep the indexing lease intact. Durable stores reclaim it after
            // expiry and retry the idempotent vector upsert.
            this.reportError(persistError, 'persist-result');
          }
          break;
        }
        try {
          await this.repository.markMemoryChunksIndexed(chunks.map((chunk) => chunk.id));
        } catch (error) {
          // The vector write succeeded, so do not overwrite the durable state
          // with a processing failure. Lease expiry safely retries the upsert.
          this.reportError(error, 'persist-result');
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
