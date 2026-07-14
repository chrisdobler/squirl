import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIDEBAR_TASKS_RATIO,
  clampSidebarTasksRatio,
  sidebarTasksRatioBounds,
  sidebarTasksRatioFromDrag,
  sidebarTasksRatioFromPointer,
} from './sidebar-task-resize.js';

describe('sidebar task resizing', () => {
  it('clamps persisted ratios to the durable safe range', () => {
    expect(clampSidebarTasksRatio(-1)).toBe(0.15);
    expect(clampSidebarTasksRatio(0.57)).toBe(0.57);
    expect(clampSidebarTasksRatio(2)).toBe(0.8);
  });

  it('converts a vertical divider position into the task share below it', () => {
    expect(sidebarTasksRatioFromPointer(300, 100, 400)).toBe(0.5);
    expect(sidebarTasksRatioFromPointer(100, 100, 400)).toBe(0.77);
    expect(sidebarTasksRatioFromPointer(500, 100, 400)).toBe(0.22);
  });

  it('resizes from the grabbed position without jumping on pointer down', () => {
    expect(sidebarTasksRatioFromDrag(0.42, 300, 300, 400)).toBe(0.42);
    expect(sidebarTasksRatioFromDrag(0.42, 300, 260, 400)).toBeCloseTo(0.52);
    expect(sidebarTasksRatioFromDrag(0.42, 300, 340, 400)).toBeCloseTo(0.32);
  });

  it('preserves both section minimum heights when calculating bounds', () => {
    expect(sidebarTasksRatioBounds(400, 100, 80)).toEqual({ min: 0.2, max: 0.75 });
    expect(sidebarTasksRatioFromPointer(490, 100, 400, 100, 80)).toBe(0.2);
    expect(sidebarTasksRatioFromPointer(110, 100, 400, 100, 80)).toBe(0.75);
  });

  it('falls back safely when the workspace cannot be measured', () => {
    expect(sidebarTasksRatioFromPointer(Number.NaN, 0, 400)).toBe(DEFAULT_SIDEBAR_TASKS_RATIO);
    expect(sidebarTasksRatioFromPointer(100, 0, 0)).toBe(DEFAULT_SIDEBAR_TASKS_RATIO);
  });

  it('uses a stable compromise when both minimum heights cannot fit', () => {
    const bounds = sidebarTasksRatioBounds(120, 92, 88);
    expect(bounds.min).toBeCloseTo(88 / 180);
    expect(bounds.max).toBe(bounds.min);
  });
});
