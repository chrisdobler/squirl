import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { Participant } from '../agents/types.js';
import { PARTICIPANT_COLOR_VALUE, roomMembers } from '../agents/participants.js';
import type { HealthEntry, ParticipantContextPreview } from './types.js';
import { ContextLegend, ContextMatrix } from './ContextMatrix.js';
import { ParticipantIdentity } from './ParticipantIdentity.js';

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
  return participant.kind === 'claude-code' ? 'Claude Code' : 'Codex CLI';
}

export function sidebarDestination(participant: Participant): 'agent' | 'model' {
  return participant.kind === 'local-llm' ? 'model' : 'agent';
}

function fidelityLabel(preview: ParticipantContextPreview): string {
  if (preview.fidelity === 'inspected-estimate') return 'inspected estimate';
  if (preview.fidelity === 'exact') return 'exact request';
  return preview.fidelity;
}

export function ContextPreviewCard({ participant, preview, loading, position, onPointerEnter, onPointerLeave }: {
  participant: Participant;
  preview: ParticipantContextPreview | null;
  loading: boolean;
  position: { left: number; top: number };
  onPointerEnter?: React.PointerEventHandler<HTMLElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLElement>;
}) {
  const usageOnly = preview?.matrixMode === 'usage';
  const availableTokens = preview?.contextWindow != null && preview.usedTokens != null
    ? Math.max(0, preview.contextWindow - preview.usedTokens)
    : null;
  return <aside className="agentContextPopover" style={position} role="tooltip" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
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
      <ContextMatrix compact tone={usageOnly ? 'neutral' : 'categorized'} label={`${participant.label} context matrix preview`} cells={preview.discs.map((kind, index) => ({ index, kind }))} />
      {usageOnly ? <div className="contextUsageLegend" aria-label="Context usage legend">
        <span><i className="used" />used {fmt(preview.usedTokens)}</span>
        <span><i className="available" />available {fmt(availableTokens)}</span>
        <small>Usage only · Codex does not expose category-level context.</small>
      </div> : <ContextLegend compact amounts={{ ...preview.buckets, available: availableTokens ?? undefined }} formatAmount={fmt} />}
      {loading && <span className="agentContextRefreshing">refreshing…</span>}
    </> : <div className="agentContextUnavailable"><strong>Context unavailable</strong></div>}
  </aside>;
}

export function RoomSidebarRoster({ participants, healthEntries, squirlDependenciesExpanded, onSquirlDependenciesExpandedChange, onSelectParticipant, loadPreview }: {
  participants: Participant[];
  healthEntries: HealthEntry[];
  squirlDependenciesExpanded: boolean;
  onSquirlDependenciesExpandedChange: (expanded: boolean) => void;
  onSelectParticipant: (participant: Participant) => void;
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
      const height = 310;
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
        return <div className={`roomRailNode${isSquirl ? ' squirlNode' : ''}`} key={participant.id}>
          <div className={`roomRailNodeRow${isSquirl ? ' hasDisclosure' : ''}`}>
            <button
              type="button"
              className={`roomRailAgent${activeId === participant.id ? ' active' : ''}`}
              aria-label={`${participant.label} @${participant.id} · ${participant.status ?? 'ready'} ${isSquirl ? 'local' : participant.kind === 'claude-code' ? 'Claude' : 'Codex'}`}
              aria-describedby={activeId === participant.id ? 'agent-context-preview' : undefined}
              onPointerEnter={(event) => open(participant, event.currentTarget, 180)}
              onPointerLeave={() => close(220)}
              onFocus={(event) => open(participant, event.currentTarget, 0)}
              onBlur={() => close(0)}
              data-destination={sidebarDestination(participant)}
              onClick={() => {
                close(0);
                onSelectParticipant(participant);
              }}
            >
              <span className="roomRailIdentity" style={{ borderColor: PARTICIPANT_COLOR_VALUE[participant.color] }} aria-hidden="true">
                {participant.label.slice(0, 1).toUpperCase()}
                <span className="roomRailStatus" style={{ background: STATUS_COLOR[participant.status ?? 'ready'] }} />
              </span>
              <span className="roomRailText"><ParticipantIdentity participant={participant} text={participant.label} marker={false} className="roomRailName"/><small>@{participant.id} · {participant.status ?? 'ready'}</small></span>
              <span className="roomRailKind">{isSquirl ? 'local' : participant.kind === 'claude-code' ? 'Claude' : 'Codex'}</span>
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
    {activeParticipant && <div id="agent-context-preview"><ContextPreviewCard participant={activeParticipant} preview={preview} loading={loading} position={position} onPointerEnter={keepOpen} onPointerLeave={() => close(160)} /></div>}
  </section>;
}
