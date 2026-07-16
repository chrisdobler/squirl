import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { Participant } from '../agents/types.js';
import { PARTICIPANT_COLOR_VALUE, roomMembers } from '../agents/participants.js';
import type { HealthEntry, ParticipantContextPreview } from './types.js';
import type { TaskActivityItem, TaskActivityState } from '../tasks/types.js';
import { ContextLegend, ContextMatrix } from './ContextMatrix.js';
import { ParticipantIdentity } from './ParticipantIdentity.js';
import { ParticipantKindIcon } from './ParticipantIcon.js';
import {
  MAX_SIDEBAR_TASKS_RATIO,
  MIN_SIDEBAR_TASKS_RATIO,
  clampSidebarTasksRatio,
  sidebarTasksRatioBounds,
  sidebarTasksRatioFromDrag,
} from './sidebar-task-resize.js';

const STATUS_COLOR: Record<NonNullable<Participant['status']>, string> = {
  starting: '#facc15', ready: '#4ade80', busy: '#60a5fa', stopped: '#94a3b8', error: '#f87171',
};

function fmt(n: number | null): string {
  if (n == null) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function kindLabel(participant: Participant): string {
  if (participant.kind === 'local-llm') return 'Squirl';
  if (participant.kind === 'claude-code') return 'Claude Code';
  return participant.kind === 'codex' ? 'Codex CLI' : 'PI Agent';
}

export function sidebarDestination(participant: Participant): 'agent' | 'model' {
  return participant.kind === 'local-llm' ? 'model' : 'agent';
}

export function contextParticipantDestination(participant: Participant): string | null {
  return participant.kind === 'local-llm' ? null : participant.id;
}

function fidelityLabel(preview: ParticipantContextPreview): string {
  if (preview.fidelity === 'inspected-estimate') return 'inspected estimate';
  if (preview.fidelity === 'exact') return 'exact request';
  return preview.fidelity;
}

export function ContextPreviewCard({ participant, preview, loading, position, operation, busy, onTerminal, onCompact, onOpenContext, onPointerEnter, onPointerLeave, onFocus, onBlur }: {
  participant: Participant;
  preview: ParticipantContextPreview | null;
  loading: boolean;
  position: { left: number; top: number };
  operation?: { operation: 'terminal' | 'compact'; state: string; message?: string };
  busy?: boolean;
  onTerminal?: () => void;
  onCompact?: () => void;
  onOpenContext?: () => void;
  onPointerEnter?: React.PointerEventHandler<HTMLElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
}) {
  const usageOnly = preview?.matrixMode === 'usage';
  const availableTokens = preview?.contextWindow != null && preview.usedTokens != null
    ? Math.max(0, preview.contextWindow - preview.usedTokens)
    : null;
  return <aside className="agentContextPopover" style={position} role={participant.kind === 'local-llm' ? 'tooltip' : 'dialog'} aria-label={participant.kind === 'local-llm' ? undefined : `${participant.label} agent actions`} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={onFocus} onBlur={onBlur}>
    <header>
      <ParticipantIdentity participant={participant} />
      <div><ParticipantIdentity participant={participant} text={participant.label} marker={false} className="rosterName"/><span>@{participant.id} · {kindLabel(participant)}</span></div>
    </header>
    {loading && !preview ? <div className="agentContextLoading" role="status">Inspecting local context…</div> : preview?.fidelity === 'unavailable' ? (
      <div className="agentContextUnavailable"><strong>Context unavailable</strong><p>{preview.unavailableReason}</p></div>
    ) : preview ? <>
      <div className="agentContextMeta">
        <span>view</span><strong>last turn input</strong>
        <span>model</span><strong>{preview.modelId ?? 'unknown'}</strong>
        <span>context</span><strong>{fmt(preview.usedTokens)} / {fmt(preview.contextWindow)} tokens</strong>
        <span>source</span><strong>{fidelityLabel(preview)}</strong>
        <span>updated</span><strong>{preview.capturedAt ? new Date(preview.capturedAt).toLocaleTimeString() : 'unknown'}</strong>
      </div>
      <ContextMatrix compact tone={usageOnly ? 'neutral' : 'categorized'} label={`Open ${participant.label} context`} onActivate={onOpenContext} cells={preview.discs.map((kind, index) => ({ index, kind }))} />
      {usageOnly ? <div className="contextUsageLegend" aria-label="Context usage legend">
        <span><i className="used" />used {fmt(preview.usedTokens)}</span>
        <span><i className="available" />available {fmt(availableTokens)}</span>
        <small>Usage only · Codex does not expose category-level context.</small>
      </div> : <ContextLegend compact amounts={{ ...preview.buckets, available: availableTokens ?? undefined }} formatAmount={fmt} />}
      {loading && <span className="agentContextRefreshing">refreshing…</span>}
    </> : <div className="agentContextUnavailable"><strong>Context unavailable</strong></div>}
    {participant.kind !== 'local-llm' && <footer className="agentContextActions">
      <button type="button" className="primary" disabled={busy || participant.controlMode === 'compacting'} onClick={onTerminal}>
        {participant.controlMode === 'terminal' ? 'Return to terminal' : 'Switch to terminal mode'}
      </button>
      <button type="button" className="chip" disabled={(participant.controlMode ?? 'headless') !== 'headless' || (operation?.operation === 'compact' && (operation.state === 'queued' || operation.state === 'running'))} onClick={onCompact}>
        {operation?.operation === 'compact' && operation.state === 'queued' ? 'Compact queued' : operation?.operation === 'compact' && operation.state === 'running' ? 'Compacting…' : 'Compact'}
      </button>
      {operation?.message && <span role={operation.state === 'error' ? 'alert' : 'status'}>{operation.message}</span>}
    </footer>}
  </aside>;
}

export function RoomSidebarRoster({ participants, activeParticipantIds, agentOperations, healthEntries, squirlDependenciesExpanded, onSquirlDependenciesExpandedChange, onSelectParticipant, onOpenTerminal, onCompact, onOpenContext, loadPreview }: {
  participants: Participant[];
  activeParticipantIds: ReadonlySet<string>;
  agentOperations?: Readonly<Record<string, { operation: 'terminal' | 'compact'; state: string; message?: string }>>;
  healthEntries: HealthEntry[];
  squirlDependenciesExpanded: boolean;
  onSquirlDependenciesExpandedChange: (expanded: boolean) => void;
  onSelectParticipant: (participant: Participant) => void;
  onOpenTerminal?: (participant: Participant) => void;
  onCompact?: (participant: Participant) => void;
  onOpenContext?: (participant: Participant) => void;
  loadPreview: (participantId: string, signal: AbortSignal) => Promise<ParticipantContextPreview>;
}) {
  const members = useMemo(() => roomMembers(participants), [participants]);
  const cache = useRef(new Map<string, ParticipantContextPreview>());
  const request = useRef<AbortController | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParticipantContextPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useEffect(() => () => {
    request.current?.abort();
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (activeId && !members.some((member) => member.id === activeId)) setActiveId(null);
  }, [activeId, members]);

  const close = (delay = 100) => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setActiveId(null), delay);
  };

  const keepOpen = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  };

  const open = (participant: Participant, element: HTMLElement, delay: number) => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    openTimer.current = window.setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const width = 300;
      const height = participant.kind === 'local-llm' ? 310 : 390;
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right + 10)),
        top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - height - 8)),
      });
      setActiveId(participant.id);
      setPreview(cache.current.get(participant.id) ?? null);
      setLoading(true);
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      void loadPreview(participant.id, controller.signal).then((next) => {
        if (controller.signal.aborted) return;
        cache.current.set(participant.id, next);
        setPreview(next);
      }).catch(() => {
        if (!controller.signal.aborted && !cache.current.has(participant.id)) setPreview(null);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, delay);
  };

  const activeParticipant = members.find((participant) => participant.id === activeId) ?? null;
  return <section className="roomRail" aria-label="Agents in this room">
    <header><h3>In this room</h3><span>{members.length}</span></header>
    <div className="roomRailList">
      {members.map((participant) => {
        const isSquirl = participant.kind === 'local-llm';
        const effectiveStatus = activeParticipantIds.has(participant.id) ? 'busy' : participant.status ?? 'ready';
        return <div className={`roomRailNode${isSquirl ? ' squirlNode' : ''}`} key={participant.id}>
          <div className={`roomRailNodeRow${isSquirl ? ' hasDisclosure' : ''}`}>
            <button
              type="button"
              className={`roomRailAgent${activeId === participant.id ? ' active' : ''}`}
              aria-label={`${participant.label} @${participant.id} · ${effectiveStatus} ${isSquirl ? 'local' : participant.kind === 'claude-code' ? 'Claude' : participant.kind === 'codex' ? 'Codex' : 'PI'}`}
              aria-describedby={activeId === participant.id ? 'agent-context-preview' : undefined}
              onPointerEnter={(event) => open(participant, event.currentTarget, 180)}
              onPointerLeave={() => close(220)}
              onFocus={(event) => open(participant, event.currentTarget, 0)}
              // Give focus time to move into the adjacent action card. Its
              // pointer/focus handlers cancel this delayed close.
              onBlur={() => close(220)}
              data-destination={sidebarDestination(participant)}
              onClick={() => {
                close(0);
                onSelectParticipant(participant);
              }}
            >
              <span className="roomRailIdentity" data-status={effectiveStatus} style={{ borderColor: PARTICIPANT_COLOR_VALUE[participant.color] }} aria-hidden="true">
                <ParticipantKindIcon kind={participant.kind} />
                <span className="roomRailStatus" style={{ background: STATUS_COLOR[effectiveStatus] }} />
              </span>
              <span className="roomRailText"><ParticipantIdentity participant={participant} text={participant.label} marker={false} className="roomRailName"/><small>@{participant.id} · {effectiveStatus}</small></span>
              <span className="roomRailKind">{isSquirl ? 'local' : participant.kind === 'claude-code' ? 'Claude' : participant.kind === 'codex' ? 'Codex' : 'PI'}</span>
            </button>
            {isSquirl && <button
              type="button"
              className="roomRailDisclosure"
              aria-label={`${squirlDependenciesExpanded ? 'Collapse' : 'Expand'} Squirl dependencies`}
              aria-expanded={squirlDependenciesExpanded}
              aria-controls="squirl-dependency-tree"
              onClick={() => onSquirlDependenciesExpandedChange(!squirlDependenciesExpanded)}
            ><span aria-hidden="true">›</span></button>}
          </div>
          {isSquirl && squirlDependenciesExpanded && <div id="squirl-dependency-tree" className="squirlDependencyTree" role="tree" aria-label="Squirl dependencies">
            {healthEntries.map((health) => <div
              className="squirlDependency"
              key={health.id}
              role="treeitem"
              title={health.detail ?? health.state}
              aria-label={`${health.label}: ${health.state}${health.detail ? ` · ${health.detail}` : ''}`}
            >
              <span className={`healthDot ${health.state}`} aria-hidden="true" />
              <span className="healthLabel">{health.label}</span>
              <small>{health.state}</small>
            </div>)}
          </div>}
        </div>;
      })}
    </div>
    {activeParticipant && <div id="agent-context-preview"><ContextPreviewCard
      participant={activeParticipant}
      preview={preview}
      loading={loading}
      position={position}
      operation={agentOperations?.[activeParticipant.id]}
      busy={activeParticipantIds.has(activeParticipant.id)}
      onOpenContext={onOpenContext ? () => { close(0); onOpenContext(activeParticipant); } : undefined}
      onTerminal={() => { keepOpen(); onOpenTerminal?.(activeParticipant); }}
      onCompact={() => { keepOpen(); onCompact?.(activeParticipant); }}
      onPointerEnter={keepOpen}
      onPointerLeave={() => close(160)}
      onFocus={keepOpen}
      onBlur={() => close(160)}
    /></div>}
  </section>;
}

function relativeActivity(timestamp: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function calendarTime(task: TaskActivityState['tasks'][number], now: number): string {
  if (!task.calendar) return relativeActivity(task.lastActiveAt, now);
  if (task.calendar.allDay) return 'all day';
  const start = new Date(task.calendar.startAt); const end = new Date(task.calendar.endAt);
  const time = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (start.getTime() <= now && end.getTime() > now) return `now · until ${time(end)}`;
  if (end.getTime() <= now) return `ended ${relativeActivity(task.calendar.endAt, now)}`;
  return `${time(start)}–${time(end)}`;
}

function isCurrentTask(task: TaskActivityItem, now: number): boolean {
  if (!task.calendar) return true;
  return Date.parse(task.calendar.startAt) <= now && Date.parse(task.calendar.endAt) > now;
}

function isUpcomingTask(task: TaskActivityItem, now: number): boolean {
  return Boolean(task.calendar && Date.parse(task.calendar.startAt) > now);
}

function taskSummary(task: TaskActivityItem): string {
  if (task.summary) return task.summary;
  if (task.calendar?.managedBySquirl) return 'Squirl inferred this work from recent conversation and agent activity. Its calendar end time keeps moving while the task remains active.';
  if (task.calendar) return 'This scheduled calendar event has not been linked to inferred project activity yet.';
  return 'Active work inferred from recent conversation and agent activity. More detail will appear after the next reliable task refresh.';
}

export function TaskSummaryCard({ task, now, position, onPointerEnter, onPointerLeave }: {
  task: TaskActivityItem;
  now: number;
  position: { left: number; top: number };
  onPointerEnter?: React.PointerEventHandler<HTMLElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLElement>;
}) {
  return <aside id="current-task-summary" className="taskSummaryPopover" style={position} role="tooltip" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    <header><span>Current task</span>{task.source === 'calendar' && <b className="calendarBadge">Calendar</b>}</header>
    <strong>{task.title}</strong>
    <p>{taskSummary(task)}</p>
    <footer><span>{calendarTime(task, now)}</span>{task.participantIds.length > 0 && <span>{task.participantIds.map((id) => `@${id}`).join(' ')}</span>}</footer>
  </aside>;
}

export function CurrentTasks({ activity, heightRatio, onHeightRatioChange, resizeContainerRef }: {
  activity: TaskActivityState;
  heightRatio: number;
  onHeightRatioChange: (ratio: number) => void;
  resizeContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [activeTask, setActiveTask] = useState<TaskActivityItem | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 });
  const [dragging, setDragging] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const dragStart = useRef<{ clientY: number; ratio: number } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(timer);
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);
  const cancelClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setActiveTask(null), 120);
  };
  const showTask = (task: TaskActivityItem, element: HTMLElement) => {
    cancelClose();
    const bounds = element.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const estimatedHeight = 210;
    const right = bounds.right + 10;
    const left = right + width <= window.innerWidth - 8 ? right : Math.max(8, bounds.left - width - 10);
    const top = Math.max(8, Math.min(bounds.top, window.innerHeight - estimatedHeight - 8));
    setPopoverPosition({ left, top });
    setActiveTask(task);
  };
  const resizeMeasurements = () => {
    const workspace = resizeContainerRef.current;
    const room = workspace?.querySelector<HTMLElement>('.roomRail');
    if (!workspace) return null;
    const bounds = workspace.getBoundingClientRect();
    const rosterMinHeight = room ? Number.parseFloat(window.getComputedStyle(room).minHeight) || 92 : 92;
    const tasksMinHeight = sectionRef.current ? Number.parseFloat(window.getComputedStyle(sectionRef.current).minHeight) || 88 : 88;
    return { bounds, rosterMinHeight, tasksMinHeight };
  };
  const resizeFromPointer = (clientY: number) => {
    const measurements = resizeMeasurements();
    if (!measurements || !dragStart.current) return;
    onHeightRatioChange(sidebarTasksRatioFromDrag(
      dragStart.current.ratio,
      dragStart.current.clientY,
      clientY,
      measurements.bounds.height,
      measurements.rosterMinHeight,
      measurements.tasksMinHeight,
    ));
  };
  const stopDragging = (event: React.PointerEvent<HTMLElement>) => {
    if (dragPointerId.current !== event.pointerId) return;
    resizeFromPointer(event.clientY);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragPointerId.current = null;
    dragStart.current = null;
    setDragging(false);
  };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    const measurements = resizeMeasurements();
    if (!measurements) return;
    const bounds = sidebarTasksRatioBounds(measurements.bounds.height, measurements.rosterMinHeight, measurements.tasksMinHeight);
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = heightRatio + step;
    else if (event.key === 'ArrowDown') next = heightRatio - step;
    else if (event.key === 'Home') next = bounds.min;
    else if (event.key === 'End') next = bounds.max;
    if (next == null) return;
    event.preventDefault();
    onHeightRatioChange(clampSidebarTasksRatio(next, bounds));
  };
  const statusLabel = activity.status === 'refreshing' || activity.calendar.status === 'refreshing' ? 'updating' : activity.status === 'stale' ? 'stale' : activity.calendar.status === 'stale' ? 'calendar stale' : activity.status === 'unavailable' && activity.tasks.length === 0 ? 'unavailable' : '';
  const hasCurrentTask = activity.tasks.some((task) => isCurrentTask(task, now));
  const showNoCurrentTask = !hasCurrentTask;
  const noCurrentTaskIndex = showNoCurrentTask
    ? activity.tasks.findIndex((task) => !isUpcomingTask(task, now))
    : -1;
  const insertionIndex = noCurrentTaskIndex < 0 ? activity.tasks.length : noCurrentTaskIndex;
  const noCurrentTask = <div className="currentTaskEmpty" role="status"><strong>No current task</strong><small>Waiting for the next assignment</small></div>;
  return <section ref={sectionRef} className="currentTasks" aria-label="Current tasks">
    <header
      className={dragging ? 'dragging' : undefined}
      role="separator"
      aria-label="Resize current tasks"
      aria-orientation="horizontal"
      aria-valuemin={Math.round(MIN_SIDEBAR_TASKS_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SIDEBAR_TASKS_RATIO * 100)}
      aria-valuenow={Math.round(heightRatio * 100)}
      aria-valuetext={`${Math.round(heightRatio * 100)}% of sidebar workspace`}
      tabIndex={0}
      onKeyDown={resizeWithKeyboard}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragPointerId.current = event.pointerId;
        dragStart.current = { clientY: event.clientY, ratio: heightRatio };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragPointerId.current === event.pointerId) resizeFromPointer(event.clientY);
      }}
      onPointerUp={stopDragging}
      onPointerCancel={(event) => {
        if (dragPointerId.current === event.pointerId) {
          dragPointerId.current = null;
          dragStart.current = null;
          setDragging(false);
        }
      }}
      onLostPointerCapture={() => {
        dragPointerId.current = null;
        dragStart.current = null;
        setDragging(false);
      }}
    ><h3>Current tasks</h3>{statusLabel && <span className={`taskActivityStatus ${activity.status}`}>{statusLabel}</span>}</header>
    {activity.error && <div className="currentTaskError" role="status">{activity.error}</div>}
    <div className="currentTaskList">
      {activity.tasks.map((task, index) => <React.Fragment key={task.id}>
        {showNoCurrentTask && index === insertionIndex && noCurrentTask}
        <div className={`currentTaskRow ${task.source === 'calendar' ? 'calendar' : ''}`} tabIndex={0} aria-describedby={activeTask?.id === task.id ? 'current-task-summary' : undefined} aria-label={`${task.title}, ${calendarTime(task, now)}${task.participantIds.length ? `, ${task.participantIds.map((id) => `@${id}`).join(', ')}` : ''}`} onPointerEnter={(event) => showTask(task, event.currentTarget)} onPointerLeave={closeSoon} onFocus={(event) => showTask(task, event.currentTarget)} onBlur={closeSoon}>
          <strong title={task.title}>{task.title}</strong>
          <small><span>{calendarTime(task, now)}{task.source === 'calendar' && <b className="calendarBadge">Calendar</b>}</span>{task.participantIds.length > 0 && <span>{task.participantIds.map((id) => `@${id}`).join(' ')}</span>}</small>
        </div>
      </React.Fragment>)}
      {showNoCurrentTask && insertionIndex === activity.tasks.length && noCurrentTask}
      {activity.tasks.length === 0 && !showNoCurrentTask && <p>{activity.status === 'refreshing' ? 'Classifying recent work…' : 'Waiting for a reliable task snapshot.'}</p>}
    </div>
    {activeTask && <TaskSummaryCard task={activeTask} now={now} position={popoverPosition} onPointerEnter={cancelClose} onPointerLeave={closeSoon} />}
  </section>;
}
