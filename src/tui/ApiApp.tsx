import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Header } from '../components/Header.js';
import { InputArea } from '../components/InputArea.js';
import { MessageList } from '../components/MessageList.js';
import { RecipientPicker } from '../components/RecipientPicker.js';
import { RoomRoster } from '../components/RoomRoster.js';
import { SQUIRL_PARTICIPANT, roomMembers } from '../agents/participants.js';
import type { Participant } from '../agents/types.js';
import type { AppState, ChatEvent } from '../web/types.js';
import type { ToolApprovalRequest } from '../web/types.js';
import type { AgentInteractionRequest } from '../agents/types.js';
import type { Message } from '../types.js';

const API_URL = process.env.SQUIRL_API_URL ?? 'http://127.0.0.1:4174';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Squirl API returned ${response.status}`);
  return value;
}

function upsert(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((item) => item.id === message.id);
  return index < 0 ? [...messages, message] : messages.map((item) => item.id === message.id ? message : item);
}

export const ApiApp: React.FC = () => {
  const { stdout } = useStdout();
  const [state, setState] = useState<AppState | null>(null);
  const [input, setInput] = useState('');
  const [recipientId, setRecipientId] = useState(SQUIRL_PARTICIPANT.id);
  const [picker, setPicker] = useState(false);
  const [roster, setRoster] = useState(false);
  const [error, setError] = useState('');
  const [toolApproval, setToolApproval] = useState<ToolApprovalRequest | null>(null);
  const [agentInteraction, setAgentInteraction] = useState<{ participantId: string; request: AgentInteractionRequest } | null>(null);
  const reconnectRef = useRef(true);

  const applyEvent = (event: ChatEvent) => {
    if (event.type === 'state') setState(event.state);
    else if (event.type === 'work-state') setState((current) => current ? { ...current, work: event.work } : current);
    else if (event.type === 'message' || event.type === 'assistant-final' || event.type === 'assistant-update' || event.type === 'activity-update') {
      setState((current) => current ? { ...current, messages: upsert(current.messages, event.message) } : current);
    } else if (event.type === 'token') {
      setState((current) => current ? { ...current, messages: current.messages.map((message) => message.id === event.assistantId && message.role === 'assistant' ? { ...message, content: message.content + event.token } : message) } : current);
    } else if (event.type === 'agent-status') {
      setState((current) => current ? { ...current, participants: current.participants.map((participant) => participant.id === event.participantId ? { ...participant, status: event.status as Participant['status'] } : participant) } : current);
    } else if (event.type === 'storage-status') {
      setState((current) => current ? { ...current, storage: { available: event.available, error: event.message } } : current);
    } else if (event.type === 'tool-approval') setToolApproval(event.request);
    else if (event.type === 'agent-interaction') setAgentInteraction({ participantId: event.participantId, request: event.request });
    else if (event.type === 'toast' || event.type === 'error') setError(event.message);
  };

  useEffect(() => {
    reconnectRef.current = true;
    const controller = new AbortController();
    void api<AppState>('/api/state').then(setState).catch((value) => setError(value instanceof Error ? value.message : String(value)));
    const connect = async () => {
      while (reconnectRef.current && !controller.signal.aborted) {
        try {
          const response = await fetch(`${API_URL}/api/events?clientId=tui`, { signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`Event stream returned ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) if (line.trim()) applyEvent(JSON.parse(line) as ChatEvent);
          }
        } catch (value) {
          if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value));
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    };
    void connect();
    return () => { reconnectRef.current = false; controller.abort(); };
  }, []);

  const participants = state?.participants ?? [];
  const recovery = useMemo(() => [...(state?.work.interrupted ?? []), ...(state?.work.failed ?? [])].filter((turn) => {
    const sourceActivityId = (turn.metadata as { sourceActivityId?: string } | undefined)?.sourceActivityId;
    if (typeof sourceActivityId !== 'string') return true;
    const source = state?.messages.find((message) => message.role === 'activity' && message.id === sourceActivityId);
    return source?.role !== 'activity' || source.activity.state !== 'succeeded';
  }), [state?.work, state?.messages]);
  const blockingActivity = useMemo(() => [...(state?.messages ?? [])].reverse().find((message): message is Extract<Message, { role: 'activity' }> => (
    message.role === 'activity' && (message.activity.kind === 'input' || message.activity.kind === 'checkpoint')
      && message.activity.state === 'blocked' && message.activity.actions.length > 0
  )), [state?.messages]);
  useEffect(() => {
    if (!agentInteraction && state?.agentInteractions[0]) setAgentInteraction(state.agentInteractions[0]);
  }, [state?.agentInteractions, agentInteraction]);
  useEffect(() => {
    if (participants.length && !roomMembers(participants).some((participant) => participant.id === recipientId)) setRecipientId(SQUIRL_PARTICIPANT.id);
  }, [participants, recipientId]);

  useInput((value, key) => {
    if (picker || roster) return;
    if (blockingActivity && (value === 'y' || value === 'n') && (blockingActivity.activity.actions.includes('approve') || blockingActivity.activity.actions.includes('reject'))) {
      void api(`/api/activities/${encodeURIComponent(blockingActivity.id)}/actions`, { method: 'POST', body: JSON.stringify({ action: value === 'y' ? 'approve' : 'reject' }) });
    } else if (toolApproval && (value === 'y' || value === 'n')) {
      void api('/api/approve', { method: 'POST', body: JSON.stringify({ id: toolApproval.id, approved: value === 'y' }) });
      setToolApproval(null);
    } else if (agentInteraction?.request.method === 'permission' && (value === 'o' || value === 'd')) {
      void api('/api/agents/interactions/respond', { method: 'POST', body: JSON.stringify({ participantId: agentInteraction.participantId, id: agentInteraction.request.id, decision: value === 'o' ? 'allow-once' : 'deny' }) });
      setAgentInteraction(null);
    } else if (key.tab) setPicker(true);
    else if (key.ctrl && value === 'r') setRoster(true);
    else if (value === 'r' && recovery[0]) void api('/api/turns/retry', { method: 'POST', body: JSON.stringify({ turnId: recovery[0].id }) });
    else if (value === 'x' && recovery[0]) void api('/api/turns/cancel', { method: 'POST', body: JSON.stringify({ turnId: recovery[0].id }) });
  });

  const submit = async (message: string) => {
    const value = message.trim();
    if (!value || !state?.storage.available) return;
    setInput(''); setError('');
    try {
      if (blockingActivity?.activity.actions.includes('respond')) {
        await api(`/api/activities/${encodeURIComponent(blockingActivity.id)}/actions`, { method: 'POST', body: JSON.stringify({ action: 'respond', value }) });
        return;
      }
      await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: value, recipientId, clientId: 'tui', requestId: crypto.randomUUID() }) });
    } catch (value) { setInput(message); setError(value instanceof Error ? value.message : String(value)); }
  };

  if (roster) return <><Header participants={participants}/><RoomRoster participants={participants} onClose={() => setRoster(false)}/></>;
  return <Box flexDirection="column" height={stdout.rows ?? 30}>
    <Header participants={participants}/>
    {picker && <RecipientPicker participants={participants} selectedId={recipientId} onClose={() => setPicker(false)} onSelect={(id) => { setRecipientId(id); setPicker(false); }}/>}
    <MessageList messages={state?.messages ?? []} participants={participants} height={Math.max(8, (stdout.rows ?? 30) - 9)}/>
    {recovery[0] && <Box borderStyle="round" borderColor="yellow" paddingX={1}><Text color="yellow">@{recovery[0].participantId} {recovery[0].status}: {recovery[0].lastError ?? recovery[0].input} · r retry · x cancel</Text></Box>}
    {blockingActivity && <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column"><Text color="yellow">{blockingActivity.activity.title}: {blockingActivity.activity.summary}</Text><Text dimColor>{blockingActivity.activity.actions.includes('respond') ? 'type a response and press enter' : 'y approve · n reject'}</Text></Box>}
    {state && !state.storage.available && <Box borderStyle="round" borderColor="red" paddingX={1}><Text color="red">Postgres unavailable: {state.storage.error}</Text></Box>}
    {error && <Box paddingX={1}><Text color="red">{error}</Text></Box>}
    <InputArea value={input} onChange={setInput} onSubmit={(value) => void submit(value)} recipientId={blockingActivity ? blockingActivity.activity.participantId : recipientId} focus={!picker && Boolean(state?.storage.available)}/>
    <Box paddingX={1}><Text dimColor>tab recipient · ctrl+r roster · server-owned durable queue</Text></Box>
  </Box>;
};
