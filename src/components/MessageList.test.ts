import { describe, expect, it } from 'vitest';
import { computeScrollbarLayout, computeViewportLayout, viewportRowsForHeight } from './MessageList.js';

describe('viewportRowsForHeight', () => {
  it('keeps the viewport at least one row tall', () => {
    expect(viewportRowsForHeight(0)).toBe(1);
    expect(viewportRowsForHeight(1)).toBe(1);
    expect(viewportRowsForHeight(2)).toBe(1);
    expect(viewportRowsForHeight(8)).toBe(6);
  });
});

describe('computeScrollbarLayout', () => {
  it('leaves the track blank when content does not scroll', () => {
    const layout = computeScrollbarLayout(5, 0, 0);

    expect(layout).toEqual({
      trackHeight: 5,
      thumbTop: 0,
      thumbSize: 5,
      rows: [' ', ' ', ' ', ' ', ' '],
    });
  });

  it('keeps one contiguous thumb in bounds at bottom, middle, and top', () => {
    const bottom = computeScrollbarLayout(10, 30, 0);
    const middle = computeScrollbarLayout(10, 30, 15);
    const top = computeScrollbarLayout(10, 30, 30);

    for (const layout of [bottom, middle, top]) {
      expect(layout.rows).toHaveLength(layout.trackHeight);
      expect(layout.thumbTop).toBeGreaterThanOrEqual(0);
      expect(layout.thumbSize).toBeGreaterThanOrEqual(1);
      expect(layout.thumbTop + layout.thumbSize).toBeLessThanOrEqual(layout.trackHeight);
      expect(layout.rows.filter((row) => row === '█')).toHaveLength(layout.thumbSize);
      expect(layout.rows.slice(layout.thumbTop, layout.thumbTop + layout.thumbSize)).toEqual(Array(layout.thumbSize).fill('█'));
    }

    expect(bottom.thumbTop).toBeGreaterThan(middle.thumbTop);
    expect(middle.thumbTop).toBeGreaterThan(top.thumbTop);
    expect(top.thumbTop).toBe(0);
  });

  it('clamps invalid dimensions and scroll offsets', () => {
    const layout = computeScrollbarLayout(0, 20, 999);

    expect(layout.trackHeight).toBe(1);
    expect(layout.rows).toHaveLength(1);
    expect(layout.thumbTop).toBe(0);
    expect(layout.thumbSize).toBe(1);
    expect(layout.rows).toEqual(['█']);
  });
});

describe('computeViewportLayout', () => {
  it('selects the bottom viewport when scroll offset is zero', () => {
    const layout = computeViewportLayout(['a', 'b', 'c', 'd', 'e'], 3, 0, ' ');

    expect(layout.maxScroll).toBe(2);
    expect(layout.viewportTop).toBe(2);
    expect(layout.rows).toEqual(['c', 'd', 'e']);
  });

  it('selects middle and top viewports from bottom-based scroll offsets', () => {
    const middle = computeViewportLayout(['a', 'b', 'c', 'd', 'e'], 3, 1, ' ');
    const top = computeViewportLayout(['a', 'b', 'c', 'd', 'e'], 3, 2, ' ');

    expect(middle.viewportTop).toBe(1);
    expect(middle.rows).toEqual(['b', 'c', 'd']);
    expect(top.viewportTop).toBe(0);
    expect(top.rows).toEqual(['a', 'b', 'c']);
  });

  it('blank-fills short content to the viewport height', () => {
    const layout = computeViewportLayout(['a'], 4, 99, ' ');

    expect(layout.maxScroll).toBe(0);
    expect(layout.clampedScroll).toBe(0);
    expect(layout.rows).toEqual(['a', ' ', ' ', ' ']);
  });

  it('keeps the viewport at least one row tall', () => {
    const layout = computeViewportLayout<string>([], 0, 0, ' ');

    expect(layout.rows).toEqual([' ']);
  });
});
