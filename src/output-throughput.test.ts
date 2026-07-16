import { describe, expect, it } from 'vitest';
import { OutputThroughputMeter } from './output-throughput.js';

describe('OutputThroughputMeter', () => {
  it('excludes time before the first output and uses provider usage at completion', () => {
    const meter = new OutputThroughputMeter();
    meter.reset();

    expect(meter.observe('first chunk', 10_000)).toBe(0);
    expect(meter.observe('x'.repeat(40), 11_000)).toBe(10);
    expect(meter.complete(24, 12_000)).toBe(12);
  });

  it('resets between model generations', () => {
    const meter = new OutputThroughputMeter();
    meter.observe('planning', 1_000);
    expect(meter.complete(8, 2_000)).toBe(8);

    meter.reset();
    expect(meter.complete(8, 20_000)).toBe(0);
    expect(meter.observe('final', 30_000)).toBe(0);
    expect(meter.complete(20, 31_000)).toBe(20);
  });

  it('captures and holds the highest live rate', () => {
    const meter = new OutputThroughputMeter();
    expect(meter.observe('first', 1_000)).toBe(0);
    expect(meter.observe('x'.repeat(40), 1_100)).toBe(100);
    expect(meter.observe('x'.repeat(80), 2_000)).toBe(100);
    expect(meter.complete(30, 3_000)).toBe(100);
  });

  it('separates the running average and final average from the held peak', () => {
    const meter = new OutputThroughputMeter();
    expect(meter.observeDetailed('first', 1_000)).toEqual({ runningAverage: 0, peak: 0 });
    expect(meter.observeDetailed('x'.repeat(40), 1_100)).toEqual({ runningAverage: 100, peak: 100 });
    expect(meter.observeDetailed('x'.repeat(80), 2_000)).toEqual({ runningAverage: 20, peak: 100 });
    expect(meter.completeDetailed(30, 3_000)).toEqual({ runningAverage: 15, peak: 100 });
  });

  it('reports a nonzero provider rate for a response delivered in one fast batch', () => {
    const meter = new OutputThroughputMeter();
    expect(meter.observe('one batch', 1_000)).toBe(0);
    expect(meter.complete(8, 1_000)).toBe(160);
  });
});
