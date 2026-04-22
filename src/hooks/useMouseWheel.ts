import { useEffect, useRef } from 'react';
import { mouseEvents } from '../mouse-filter.js';

interface UseMouseWheelOptions {
  onScroll: (delta: number) => void;
  isActive?: boolean;
}

export function useMouseWheel({ onScroll, isActive = true }: UseMouseWheelOptions): void {
  const callbackRef = useRef(onScroll);
  callbackRef.current = onScroll;

  useEffect(() => {
    if (!isActive) return;

    let recentCount = 0;
    let decayId: ReturnType<typeof setTimeout> | null = null;
    let pendingDelta = 0;
    let throttled = false;

    const flush = () => {
      throttled = false;
      if (pendingDelta !== 0) {
        callbackRef.current(pendingDelta);
        pendingDelta = 0;
      }
    };

    const handler = (direction: string) => {
      recentCount++;
      const step = recentCount > 6 ? 3 : 1;
      const delta = (direction === 'up' ? 1 : -1) * step;

      if (!throttled) {
        // First event in this frame — fire immediately
        callbackRef.current(delta);
        throttled = true;
        setTimeout(flush, 32); // ~30fps cap — coalesce excess events
      } else {
        // Already fired this frame — accumulate into next flush
        pendingDelta += delta;
      }

      if (decayId) clearTimeout(decayId);
      decayId = setTimeout(() => { recentCount = 0; }, 150);
    };

    mouseEvents.on('wheel', handler);
    return () => {
      mouseEvents.off('wheel', handler);
      if (decayId) clearTimeout(decayId);
    };
  }, [isActive]);
}
