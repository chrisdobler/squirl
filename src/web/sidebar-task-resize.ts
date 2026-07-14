export const DEFAULT_SIDEBAR_TASKS_RATIO = 0.42;
export const MIN_SIDEBAR_TASKS_RATIO = 0.15;
export const MAX_SIDEBAR_TASKS_RATIO = 0.8;

export interface SidebarTasksRatioBounds {
  min: number;
  max: number;
}

export function clampSidebarTasksRatio(
  value: number,
  bounds: SidebarTasksRatioBounds = { min: MIN_SIDEBAR_TASKS_RATIO, max: MAX_SIDEBAR_TASKS_RATIO },
): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

export function sidebarTasksRatioBounds(
  availableHeight: number,
  rosterMinHeight = 92,
  tasksMinHeight = 88,
): SidebarTasksRatioBounds {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) {
    return { min: MIN_SIDEBAR_TASKS_RATIO, max: MAX_SIDEBAR_TASKS_RATIO };
  }

  const min = Math.max(MIN_SIDEBAR_TASKS_RATIO, Math.min(MAX_SIDEBAR_TASKS_RATIO, tasksMinHeight / availableHeight));
  const max = Math.min(MAX_SIDEBAR_TASKS_RATIO, Math.max(MIN_SIDEBAR_TASKS_RATIO, 1 - rosterMinHeight / availableHeight));
  if (min <= max) return { min, max };

  const compromise = clampSidebarTasksRatio(tasksMinHeight / Math.max(1, tasksMinHeight + rosterMinHeight));
  return { min: compromise, max: compromise };
}

export function sidebarTasksRatioFromPointer(
  clientY: number,
  workspaceTop: number,
  availableHeight: number,
  rosterMinHeight = 92,
  tasksMinHeight = 88,
): number {
  const bounds = sidebarTasksRatioBounds(availableHeight, rosterMinHeight, tasksMinHeight);
  if (!Number.isFinite(clientY) || !Number.isFinite(workspaceTop) || availableHeight <= 0) {
    return clampSidebarTasksRatio(DEFAULT_SIDEBAR_TASKS_RATIO, bounds);
  }
  return clampSidebarTasksRatio(1 - (clientY - workspaceTop) / availableHeight, bounds);
}

export function sidebarTasksRatioFromDrag(
  startRatio: number,
  startClientY: number,
  clientY: number,
  availableHeight: number,
  rosterMinHeight = 92,
  tasksMinHeight = 88,
): number {
  const bounds = sidebarTasksRatioBounds(availableHeight, rosterMinHeight, tasksMinHeight);
  if (![startRatio, startClientY, clientY, availableHeight].every(Number.isFinite) || availableHeight <= 0) {
    return clampSidebarTasksRatio(startRatio, bounds);
  }
  return clampSidebarTasksRatio(startRatio + (startClientY - clientY) / availableHeight, bounds);
}
