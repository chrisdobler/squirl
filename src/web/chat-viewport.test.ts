import { describe, expect, it } from 'vitest';
import { restoredChatScrollTop, type ChatViewportSnapshot } from './chat-viewport.js';

const layout = { currentScrollTop: 0, scrollHeight: 2000, clientHeight: 500, listTop: 100 };

describe('chat viewport restoration', () => {
  it('returns pinned users to the latest message', () => {
    expect(restoredChatScrollTop({ scrollTop: 300, atLatest: true }, layout)).toBe(1500);
  });

  it('restores the visible message anchor and vertical offset', () => {
    const snapshot: ChatViewportSnapshot = { scrollTop: 700, atLatest: false, anchorMessageId: 'm2', anchorOffset: 24 };
    expect(restoredChatScrollTop(snapshot, { ...layout, currentScrollTop: 650, anchorTop: 180 })).toBe(706);
  });

  it('falls back to the saved scroll position when the anchor disappeared', () => {
    expect(restoredChatScrollTop({ scrollTop: 700, atLatest: false, anchorMessageId: 'gone', anchorOffset: 20 }, layout)).toBe(700);
  });
});
