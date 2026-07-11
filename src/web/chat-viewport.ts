export interface ChatViewportSnapshot {
  scrollTop: number;
  atLatest: boolean;
  anchorMessageId?: string;
  anchorOffset?: number;
}

export interface ChatViewportLayout {
  currentScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  listTop: number;
  anchorTop?: number;
}

export function restoredChatScrollTop(snapshot: ChatViewportSnapshot, layout: ChatViewportLayout): number {
  const maxScroll = Math.max(0, layout.scrollHeight - layout.clientHeight);
  if (snapshot.atLatest) return maxScroll;
  const target = snapshot.anchorOffset != null && layout.anchorTop != null
    ? layout.currentScrollTop + (layout.anchorTop - layout.listTop - snapshot.anchorOffset)
    : snapshot.scrollTop;
  return Math.max(0, Math.min(maxScroll, target));
}
