import React, { useEffect, useState } from 'react';
import type { ActivityMessage, AgentActivityAction } from '../types.js';

const API_BASE = (import.meta.env.VITE_SQUIRL_API_BASE as string | undefined)?.replace(/\/$/, '')
  || (typeof window === 'undefined' ? '' : window.location.origin);

function elapsed(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return '';
  const milliseconds = Math.max(0, Date.parse(finishedAt ?? new Date().toISOString()) - Date.parse(startedAt));
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function actionLabel(action: AgentActivityAction): string {
  if (action === 'check-status') return 'Check status';
  if (action === 'resume') return 'Continue research';
  return action[0]!.toUpperCase() + action.slice(1);
}

function checkedLabel(checkedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 1_000));
  if (seconds < 5) return 'Checked just now';
  if (seconds < 60) return `Checked ${seconds}s ago`;
  return `Checked ${Math.floor(seconds / 60)}m ago`;
}

export function AgentActivityCardView({ message, pinned = false }: { message: ActivityMessage; pinned?: boolean }) {
  const card = message.activity;
  const [clock, setClock] = useState(Date.now());
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!['running', 'waiting', 'queued'].includes(card.state)) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [card.state]);
  const act = async (action: AgentActivityAction) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API_BASE}/api/activities/${encodeURIComponent(message.id)}/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(value ? { value } : {}) }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Activity action failed (${response.status})`);
      setValue('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const progress = card.progress;
  const progressText = progress
    ? [progress.completed !== undefined ? `${progress.completed} completed` : '', progress.active !== undefined ? `${progress.active} active` : '', progress.unfinished !== undefined ? `${progress.unfinished} unfinished` : '', progress.total !== undefined ? `${progress.total} total` : ''].filter(Boolean).join(' · ')
    : '';
  const needsValue = card.actions.includes('respond')
    && (card.provider?.interactionMethod === 'input' || card.provider?.interactionMethod === 'editor');
  const visibleActions = card.provider?.interactionMethod === 'permission'
    ? card.actions.filter((action) => action !== 'respond')
    : card.actions;
  if (card.state === 'blocked' && card.provider?.interactionMethod === 'permission') return <section className="agentInteractionPrompt permission activityPermissionPrompt" role="region" aria-label={`${card.title}; ${card.state}`}>
    <div className="interactionPromptMark" aria-hidden="true">?</div>
    <div className="interactionPromptContent">
      <div className="interactionPromptEyebrow"><span>@{card.participantId}</span><span>{card.phase ?? 'Permission'}</span></div>
      <strong>{card.detail || card.summary || card.title}</strong>
      {card.summary && card.summary !== card.detail && <small>{card.summary}</small>}
    </div>
    <div className="interactionPromptActions">
      {visibleActions.includes('reject') && <button type="button" disabled={busy} onClick={() => void act('reject')}>Deny</button>}
      {visibleActions.includes('approve') && <button type="button" className="primary" disabled={busy} onClick={() => void act('approve')}>Allow once</button>}
    </div>
    {error && <p className="activityError interactionPromptError" role="alert">{error}</p>}
  </section>;
  const body = <>
    {pinned && <div className="activityCardHeader">
      <span className={`activityState ${card.state}`} aria-hidden="true" />
      <strong>{card.title}</strong>
      <span>{card.state}</span>
      {card.startedAt && <time>{elapsed(card.startedAt, card.finishedAt)}</time>}
    </div>}
    {card.summary && <p>{card.summary}</p>}
    <div className="activityFacts">
      {card.phase && <span>{card.phase}</span>}
      {progressText && <span>{progressText}</span>}
      <span>updated {new Date(card.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
      {card.checkedAt && <span className="activityChecked" role="status">{checkedLabel(card.checkedAt, clock)}</span>}
    </div>
    {!!card.workers?.length && <section className="activityWorkers" aria-label={`${card.workers.length} ${card.state === 'stalled' ? 'unfinished' : 'running'} agents`}>
      <strong>{card.state === 'stalled' ? 'Unfinished' : 'Running'} agents ({card.workers.length})</strong>
      <ul>{card.workers.map((worker) => <li key={worker.id} title={worker.id}><span className="activityWorkerState" aria-hidden="true"/><div><span>{worker.label}</span>{worker.detail && <small>{worker.detail}</small>}</div><code>{worker.id.slice(0, 8)}</code></li>)}</ul>
    </section>}
    {card.detail && <p className="activityDetail">{card.detail}</p>}
    {card.error && <p className="activityError">{card.error}</p>}
    {!!card.artifacts?.length && <div className="activityArtifacts">{card.artifacts.map((artifact) => <button key={artifact.path} type="button" onClick={() => {
      if (window.squirlDesktop?.openPath) void window.squirlDesktop.openPath(artifact.path);
      else void navigator.clipboard.writeText(artifact.path);
    }}>{artifact.label}</button>)}</div>}
    {!!card.actions.length && <div className="activityActions">
      {needsValue && <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Type your response" aria-label="Activity response" />}
      {visibleActions.map((action) => <button key={action} type="button" disabled={busy || (action === 'respond' && !value.trim())} className={action === 'reject' || action === 'cancel' ? 'danger' : action === 'approve' || action === 'resume' ? 'primary' : ''} onClick={() => void act(action)}>{busy && action === 'check-status' ? 'Checking…' : actionLabel(action)}</button>)}
    </div>}
    {error && <p className="activityError" role="alert">{error}</p>}
  </>;

  if (pinned) return <section className={`agentActivityCard pinned ${card.kind}`} aria-label={`${card.title}; ${card.state}`}>{body}</section>;
  return <details className={`agentActivityCard ${card.kind}`} open={!card.collapsed}>
    <summary aria-label={`${card.title}; ${card.state}`}><span className={`activityState ${card.state}`} aria-hidden="true"/><strong>{card.title}</strong><span>{card.state}</span>{card.startedAt && <time>{elapsed(card.startedAt, card.finishedAt)}</time>}</summary>
    <div className="activityCardBody">{body}</div>
  </details>;
}
