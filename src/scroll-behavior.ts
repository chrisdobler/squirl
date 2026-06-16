export function clampScrollOffset(offset: number, maxScroll: number): number {
  return Math.max(0, Math.min(Math.max(0, maxScroll), offset));
}

export function applyScrollDelta(prevOffset: number, delta: number, maxScroll: number): number {
  return clampScrollOffset(prevOffset + delta, maxScroll);
}

export function nextStreamingScrollOffset({
  prevOffset,
  prevMax,
  nextMax,
  autoscroll,
}: {
  prevOffset: number;
  prevMax: number;
  nextMax: number;
  autoscroll: boolean;
}): number {
  if (autoscroll) return 0;

  const growth = Math.max(0, nextMax - prevMax);
  return clampScrollOffset(prevOffset + growth, nextMax);
}

export function nextAutoscrollEnabled({
  isStreaming,
  current,
  delta,
  nextOffset,
}: {
  isStreaming: boolean;
  current: boolean;
  delta: number;
  nextOffset: number;
}): boolean {
  if (!isStreaming) return current;
  if (delta > 0) return false;
  if (nextOffset === 0) return true;
  return current;
}
