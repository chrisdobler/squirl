import { describe, expect, it, vi } from 'vitest';
import { createWheelScrollAccumulator, normalizeWheelStep } from './useMouseWheel.js';

describe('createWheelScrollAccumulator', () => {
  it('emits three rows immediately for a wheel-up event by default', () => {
    const onScroll = vi.fn();
    const accumulator = createWheelScrollAccumulator(onScroll);

    accumulator.push('up');

    expect(onScroll.mock.calls).toEqual([[3]]);
  });

  it('emits three rows immediately for a wheel-down event by default', () => {
    const onScroll = vi.fn();
    const accumulator = createWheelScrollAccumulator(onScroll);

    accumulator.push('down');

    expect(onScroll.mock.calls).toEqual([[-3]]);
  });

  it('tracks rapid bursts in real time with no queued catch-up', () => {
    const onScroll = vi.fn();
    const accumulator = createWheelScrollAccumulator(onScroll);

    for (let i = 0; i < 4; i++) accumulator.push('up');
    for (let i = 0; i < 2; i++) accumulator.push('down');

    expect(onScroll.mock.calls).toEqual([[3], [3], [3], [3], [-3], [-3]]);
  });

  it('respects a custom wheel step', () => {
    const onScroll = vi.fn();
    const accumulator = createWheelScrollAccumulator(onScroll, 5);

    accumulator.push('up');
    accumulator.push('down');

    expect(onScroll.mock.calls).toEqual([[5], [-5]]);
  });

  it('does not emit anything after dispose', () => {
    vi.useFakeTimers();
    const onScroll = vi.fn();
    const accumulator = createWheelScrollAccumulator(onScroll);

    accumulator.push('up');
    accumulator.dispose();
    vi.runOnlyPendingTimers();

    expect(onScroll.mock.calls).toEqual([[3]]);
    vi.useRealTimers();
  });
});

describe('normalizeWheelStep', () => {
  it('uses the default for invalid values', () => {
    expect(normalizeWheelStep()).toBe(3);
    expect(normalizeWheelStep(Number.NaN)).toBe(3);
    expect(normalizeWheelStep(0)).toBe(1);
  });

  it('clamps and truncates configured values', () => {
    expect(normalizeWheelStep(6.9)).toBe(6);
    expect(normalizeWheelStep(-4)).toBe(1);
    expect(normalizeWheelStep(100)).toBe(20);
  });
});
