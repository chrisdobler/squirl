import { useEffect, useRef } from 'react';
import { mouseEvents } from '../mouse-filter.js';

interface UseMouseWheelOptions {
  /** Called with accumulated scroll delta (positive = up, negative = down) */
  onScroll: (delta: number) => void;
  isActive?: boolean;
}

export function useMouseWheel({ onScroll, isActive = true }: UseMouseWheelOptions): void {
  const callbackRef = useRef(onScroll);
  callbackRef.current = onScroll;

  useEffect(() => {
    if (!isActive) return;

    const handler = (direction: string) => {
      callbackRef.current(direction === 'up' ? 1 : -1);
    };

    mouseEvents.on('wheel', handler);
    return () => {
      mouseEvents.off('wheel', handler);
    };
  }, [isActive]);
}
