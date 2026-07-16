import { estimateTokens } from './context/token-estimator.js';

export interface OutputThroughputReading {
  runningAverage: number;
  peak: number;
}

/** Measures one model generation, excluding pipeline work and time to first output. */
export class OutputThroughputMeter {
  private firstOutputAt: number | null = null;
  private peakTokensPerSecond = 0;

  private capture(tokens: number, now: number): OutputThroughputReading {
    if (this.firstOutputAt === null || tokens <= 0) return { runningAverage: 0, peak: this.peakTokensPerSecond };
    // Streaming callbacks can be delivered in sub-millisecond bursts. A short
    // floor prevents a transport batch from appearing as an infinite rate while
    // still allowing fast local models to register before 500 ms has elapsed.
    const elapsedSeconds = Math.max(0.05, (now - this.firstOutputAt) / 1_000);
    const runningAverage = Math.round(tokens / elapsedSeconds);
    this.peakTokensPerSecond = Math.max(this.peakTokensPerSecond, runningAverage);
    return { runningAverage, peak: this.peakTokensPerSecond };
  }

  reset(): void {
    this.firstOutputAt = null;
    this.peakTokensPerSecond = 0;
  }

  observe(content: string, now = Date.now()): number {
    return this.observeDetailed(content, now).peak;
  }

  observeDetailed(content: string, now = Date.now()): OutputThroughputReading {
    if (!content) return { runningAverage: 0, peak: this.peakTokensPerSecond };
    if (this.firstOutputAt === null) {
      this.firstOutputAt = now;
      return { runningAverage: 0, peak: 0 };
    }
    return this.capture(estimateTokens(content), now);
  }

  complete(completionTokens: number, now = Date.now()): number {
    return this.completeDetailed(completionTokens, now).peak;
  }

  completeDetailed(completionTokens: number, now = Date.now()): OutputThroughputReading {
    return this.capture(completionTokens, now);
  }
}
