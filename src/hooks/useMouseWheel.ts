import { useEffect, useRef } from 'react';
import { mouseEvents } from '../mouse-filter.js';

interface UseMouseWheelOptions {
  onScroll: (delta: number) => void;
  isActive?: boolean;
  linesPerWheel?: number;
}

type WheelDirection = 'up' | 'down';

const DEFAULT_WHEEL_STEP = 3;
const MIN_WHEEL_STEP = 1;
const MAX_WHEEL_STEP = 20;

export interface WheelScrollAccumulator {
  push: (direction: WheelDirection) => void;
  dispose: () => void;
}

export function normalizeWheelStep(linesPerWheel?: number): number {
  if (!Number.isFinite(linesPerWheel)) return DEFAULT_WHEEL_STEP;
  return Math.max(MIN_WHEEL_STEP, Math.min(MAX_WHEEL_STEP, Math.trunc(linesPerWheel!)));
}

export function createWheelScrollAccumulator(
  onScroll: (delta: number) => void,
  linesPerWheel = DEFAULT_WHEEL_STEP,
): WheelScrollAccumulator {
  const wheelStep = normalizeWheelStep(linesPerWheel);

  return {
    push(direction) {
      onScroll((direction === 'up' ? 1 : -1) * wheelStep);
    },
    dispose() {},
  };
}

export function useMouseWheel({ onScroll, isActive = true, linesPerWheel }: UseMouseWheelOptions): void {
  const callbackRef = useRef(onScroll);
  callbackRef.current = onScroll;

  useEffect(() => {
    if (!isActive) return;

    const accumulator = createWheelScrollAccumulator((delta) => callbackRef.current(delta), linesPerWheel);

    const handler = (direction: string) => {
      if (direction !== 'up' && direction !== 'down') return;
      accumulator.push(direction);
    };

    mouseEvents.on('wheel', handler);
    return () => {
      mouseEvents.off('wheel', handler);
      accumulator.dispose();
    };
  }, [isActive, linesPerWheel]);
}
