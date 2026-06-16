import { describe, expect, it } from 'vitest';
import {
  applyScrollDelta,
  clampScrollOffset,
  nextAutoscrollEnabled,
  nextStreamingScrollOffset,
} from './scroll-behavior.js';

describe('scroll behavior', () => {
  it('clamps offsets into the scroll range', () => {
    expect(clampScrollOffset(-5, 10)).toBe(0);
    expect(clampScrollOffset(4, 10)).toBe(4);
    expect(clampScrollOffset(99, 10)).toBe(10);
    expect(clampScrollOffset(5, -1)).toBe(0);
  });

  it('applies manual deltas within bounds', () => {
    expect(applyScrollDelta(0, 3, 10)).toBe(3);
    expect(applyScrollDelta(9, 3, 10)).toBe(10);
    expect(applyScrollDelta(2, -5, 10)).toBe(0);
  });

  it('keeps streaming autoscroll pinned to bottom as content grows', () => {
    expect(nextStreamingScrollOffset({
      prevOffset: 8,
      prevMax: 10,
      nextMax: 20,
      autoscroll: true,
    })).toBe(0);
  });

  it('preserves the reading position when streaming autoscroll is cancelled', () => {
    expect(nextStreamingScrollOffset({
      prevOffset: 4,
      prevMax: 10,
      nextMax: 15,
      autoscroll: false,
    })).toBe(9);
  });

  it('disables autoscroll when the user scrolls up during streaming', () => {
    expect(nextAutoscrollEnabled({
      isStreaming: true,
      current: true,
      delta: 3,
      nextOffset: 3,
    })).toBe(false);
  });

  it('re-enables autoscroll when the user scrolls back to bottom during streaming', () => {
    expect(nextAutoscrollEnabled({
      isStreaming: true,
      current: false,
      delta: -3,
      nextOffset: 0,
    })).toBe(true);
  });

  it('leaves autoscroll unchanged outside streaming', () => {
    expect(nextAutoscrollEnabled({
      isStreaming: false,
      current: true,
      delta: 3,
      nextOffset: 3,
    })).toBe(true);
  });
});
