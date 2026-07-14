import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquirlRuntime } from './runtime.js';
import type { ChatEvent, EvalEvent, EvalRunRequest } from './types.js';
import type { AgentKind, ClaudePermissionMode, CodexSandbox, PiToolMode } from '../agents/types.js';
import type { EffortLevel } from '../types.js';
import type { UiStatePatch } from './ui-state.js';
import { UiStateStore } from './ui-state-store.js';
import { discoverCodexModels } from '../agents/codex-models.js';
import { discoverClaudeModels } from '../agents/claude-models.js';
import { discoverPiModels, resolvePiBinary } from '../agents/pi-models.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface SquirlServerOptions {
  port?: number;
  host?: string;
  workingDir?: string;
  staticDir?: string;
  uiStatePath?: string;
  /** Injection seam for API tests and embedders that already own a runtime. */
  runtime?: SquirlRuntime;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, err: unknown, status = 500): void {
  sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1');
}

function createEventWriter<T = ChatEvent>(res: ServerResponse): (event: T) => void {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  return (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
}

function serveStatic(res: ServerResponse, staticDir: string, pathname: string): void {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(staticDir, requested.slice(1));
  if (!candidate.startsWith(resolve(staticDir))) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  const file = existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(staticDir, 'index.html');

  if (!existsSync(file)) {
    sendJson(res, 404, { error: 'Web UI has not been built. Run pnpm build:web first.' });
    return;
  }

  const ext = extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

export function createSquirlServer(options: SquirlServerOptions = {}) {
  const runtime = options.runtime ?? new SquirlRuntime(options.workingDir ?? process.cwd());
  const uiState = new UiStateStore(options.uiStatePath);
  const staticDir = options.staticDir ?? resolve(__dirname, '../../dist-web');

  const server = createServer(async (req, res) => {
    const url = parseUrl(req);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
        });
        res.end();
        return;
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        sendJson(res, 200, runtime.getState());
        return;
      }

      if (url.pathname === '/api/ui-state' && req.method === 'GET') {
        sendJson(res, 200, uiState.load());
        return;
      }

      if (url.pathname === '/api/ui-state' && req.method === 'PATCH') {
        const body = await readBody(req);
        sendJson(res, 200, uiState.patch(body as UiStatePatch));
        return;
      }

      if (url.pathname === '/api/system' && req.method === 'GET') {
        sendJson(res, 200, { content: runtime.systemPrompt() });
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, await runtime.updateConfig(body as never));
        return;
      }

      if (url.pathname === '/api/calendar/status' && req.method === 'GET') {
        sendJson(res, 200, runtime.getTaskActivityState().calendar);
        return;
      }

      if (url.pathname === '/api/calendar/oauth/start' && req.method === 'GET') {
        const callbackOrigin = `http://${req.headers.host ?? '127.0.0.1:4174'}`;
        const returnOrigin = typeof req.headers.origin === 'string' && req.headers.origin !== 'null'
          ? req.headers.origin : callbackOrigin;
        sendJson(res, 200, { authorizationUrl: runtime.calendarAuthorizationUrl(callbackOrigin, returnOrigin) });
        return;
      }

      if (url.pathname === '/api/calendar/oauth/callback' && req.method === 'GET') {
        const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
        if (!code || !state) throw new Error(url.searchParams.get('error') || 'Missing Google authorization response.');
        const returnUri = await runtime.completeCalendarAuthorization(code, state);
        const callbackOrigin = `http://${req.headers.host ?? '127.0.0.1:4174'}`;
        if (returnUri !== callbackOrigin) {
          sendRedirect(res, returnUri);
          return;
        }
        sendHtml(res, 200, '<!doctype html><title>Squirl Calendar connected</title><p>Google Calendar is connected. <a href="/">Return to Squirl</a>.</p>');
        return;
      }

      if (url.pathname === '/api/calendar/selection' && req.method === 'POST') {
        const body = await readBody(req) as { calendarIds?: string[] };
        sendJson(res, 200, await runtime.updateCalendarSelection(Array.isArray(body.calendarIds) ? body.calendarIds : []));
        return;
      }

      if (url.pathname === '/api/calendar/refresh' && req.method === 'POST') {
        await runtime.refreshCalendar();
        sendJson(res, 200, runtime.getState());
        return;
      }

      if (url.pathname === '/api/calendar/disconnect' && req.method === 'POST') {
        sendJson(res, 200, await runtime.disconnectCalendar());
        return;
      }

      if (url.pathname === '/api/model' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, await runtime.selectModel((body as { model: never }).model));
        return;
      }

      if (url.pathname === '/api/model/test' && req.method === 'POST') {
        const body = await readBody(req) as { model?: never };
        sendJson(res, 200, await runtime.testModelConnection(body.model));
        return;
      }

      if (url.pathname === '/api/models' && req.method === 'GET') {
        const baseUrl = url.searchParams.get('baseUrl') ?? 'http://localhost:8000/v1';
        sendJson(res, 200, await runtime.detectModels(baseUrl));
        return;
      }

      if (url.pathname === '/api/files' && req.method === 'GET') {
        sendJson(res, 200, { files: runtime.listWorkspaceFiles(url.searchParams.get('q') ?? '') });
        return;
      }

      if (url.pathname === '/api/directories' && req.method === 'GET') {
        sendJson(res, 200, runtime.listDirectories(url.searchParams.get('path') ?? runtime.getState().status.workingDir));
        return;
      }

      if (url.pathname === '/api/context/add' && req.method === 'POST') {
        const body = await readBody(req) as { path?: string };
        if (!body.path) throw new Error('Missing path');
        sendJson(res, 200, runtime.addContextFile(body.path));
        return;
      }

      if (url.pathname === '/api/context/remove' && req.method === 'POST') {
        const body = await readBody(req) as { path?: string };
        if (!body.path) throw new Error('Missing path');
        sendJson(res, 200, runtime.removeContextFile(body.path));
        return;
      }

      if (url.pathname === '/api/context/clear' && req.method === 'POST') {
        sendJson(res, 200, runtime.clearContextFiles());
        return;
      }

      if (url.pathname === '/api/context/snapshot' && req.method === 'GET') {
        sendJson(res, 200, { snapshot: runtime.getContextSnapshot() });
        return;
      }

      const participantContextMatch = url.pathname.match(/^\/api\/participants\/([^/]+)\/context-preview$/);
      if (participantContextMatch && req.method === 'GET') {
        const participantId = decodeURIComponent(participantContextMatch[1]!);
        const preview = runtime.getParticipantContextPreview(participantId);
        if (!preview) {
          sendJson(res, 404, { error: `No participant "${participantId}" is in the room.` });
          return;
        }
        sendJson(res, 200, { preview });
        return;
      }

      if (url.pathname === '/api/import' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, await runtime.importHistory(body as never));
        return;
      }

      if (url.pathname === '/api/recall' && req.method === 'POST') {
        const body = await readBody(req) as { query?: string };
        if (!body.query) throw new Error('Missing query');
        sendJson(res, 200, { message: await runtime.recall(body.query), state: runtime.getState() });
        return;
      }

      if (url.pathname === '/api/rewind/candidates' && req.method === 'GET') {
        sendJson(res, 200, { candidates: runtime.rewindCandidates() });
        return;
      }

      if (url.pathname === '/api/rewind' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, await runtime.rewind(body as never));
        return;
      }

      if (url.pathname === '/api/approve' && req.method === 'POST') {
        const body = await readBody(req) as { id?: string; approved?: boolean };
        if (!body.id) throw new Error('Missing approval id');
        sendJson(res, 200, { ok: runtime.approveToolRequest(body.id, !!body.approved) });
        return;
      }

      if (url.pathname === '/api/agents/interactions/respond' && req.method === 'POST') {
        const body = await readBody(req) as { participantId?: string; id?: string; value?: string; confirmed?: boolean; cancelled?: boolean };
        if (!body.participantId || !body.id) throw new Error('Missing PI interaction participant or id');
        await runtime.respondToAgentInteraction(body.participantId, body.id, {
          ...(body.value !== undefined ? { value: body.value } : {}),
          ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
          ...(body.cancelled !== undefined ? { cancelled: body.cancelled } : {}),
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/cancel' && req.method === 'POST') {
        const body = await readBody(req) as { participantId?: string };
        sendJson(res, 200, { ok: runtime.cancel(body.participantId) });
        return;
      }

      if (url.pathname === '/api/queue/remove' && req.method === 'POST') {
        const body = await readBody(req) as { turnId?: string };
        if (!body.turnId) throw new Error('Missing queued turn id');
        sendJson(res, 200, { ok: runtime.removeQueuedTurn(body.turnId) });
        return;
      }

      if (url.pathname === '/api/agents/rename' && req.method === 'POST') {
        const body = await readBody(req) as { id?: string; name?: string };
        if (!body.id || !body.name) throw new Error('Missing agent id or name');
        const result = await runtime.renameAgent(body.id, body.name);
        if (!result.ok) throw new Error(result.error);
        sendJson(res, 200, { state: runtime.getState(), agent: result });
        return;
      }

      if (url.pathname === '/api/agents/update' && req.method === 'POST') {
        const body = await readBody(req) as { id?: string; name?: string; model?: string | null; effort?: EffortLevel | null; cwd?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; piToolMode?: PiToolMode };
        if (!body.id) throw new Error('Missing agent id');
        const result = await runtime.updateAgent(body.id, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
          ...(body.sandbox !== undefined ? { sandbox: body.sandbox } : {}),
          ...(body.piToolMode !== undefined ? { piToolMode: body.piToolMode } : {}),
        });
        if (!result.ok) throw new Error(result.error);
        sendJson(res, 200, { state: runtime.getState(), agent: result });
        return;
      }

      if (url.pathname === '/api/agents/models' && req.method === 'GET') {
        const kind = url.searchParams.get('kind');
        if (kind !== 'codex' && kind !== 'claude-code' && kind !== 'pi') throw new Error('Agent kind must be claude-code, codex, or pi');
        const discovery = kind === 'codex'
          ? discoverCodexModels()
          : kind === 'claude-code'
            ? discoverClaudeModels()
            : await discoverPiModels(resolvePiBinary(runtime.getState().config.agents?.piBin), runtime.getState().status.workingDir);
        if (discovery.models.length === 0) throw new Error(`${kind === 'codex' ? 'Codex' : kind === 'claude-code' ? 'Claude Code' : 'PI'} has no available models.`);
        sendJson(res, 200, discovery);
        return;
      }

      if (url.pathname === '/api/agents/add' && req.method === 'POST') {
        const body = await readBody(req) as { kind?: AgentKind; id?: string; model?: string; effort?: EffortLevel; cwd?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; piToolMode?: PiToolMode };
        if (body.kind !== 'claude-code' && body.kind !== 'codex' && body.kind !== 'pi') throw new Error('Agent kind must be claude-code, codex, or pi');
        const result = await runtime.addAgent(body.kind, { id: body.id, model: body.model, effort: body.effort, cwd: body.cwd, permissionMode: body.permissionMode, sandbox: body.sandbox, piToolMode: body.piToolMode });
        if (!result.ok) throw new Error(result.error);
        sendJson(res, 200, { state: runtime.getState(), agent: result });
        return;
      }

      if (url.pathname === '/api/agents/stop' && req.method === 'POST') {
        const body = await readBody(req) as { id?: string };
        if (!body.id) throw new Error('Missing agent id');
        if (!await runtime.stopAgent(body.id)) throw new Error(`No agent @${body.id}`);
        sendJson(res, 200, { state: runtime.getState() });
        return;
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        const write = createEventWriter(res);
        const unsubscribe = runtime.subscribeEvents(write, url.searchParams.get('clientId') ?? undefined);
        const heartbeat = setInterval(() => res.write('\n'), 15_000);
        const close = () => { clearInterval(heartbeat); unsubscribe(); };
        req.once('close', close);
        res.once('close', close);
        return;
      }

      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req) as { message?: string; recipientId?: string; clientId?: string };
        const result = runtime.submitChat(body.message ?? '', body.recipientId ?? 'squirl', body.clientId);
        sendJson(res, 202, {
          turnId: result.turn.id,
          participantId: result.turn.participantId,
          started: result.started,
          queuePosition: result.queuePosition,
        });
        return;
      }

      if (url.pathname === '/api/eval/history' && req.method === 'GET') {
        sendJson(res, 200, { history: runtime.getEvalHistory() });
        return;
      }

      if (url.pathname === '/api/eval/run' && req.method === 'POST') {
        const body = await readBody(req) as EvalRunRequest;
        const write = createEventWriter<EvalEvent>(res);
        try {
          await runtime.runEval(body, write);
        } catch (err) {
          write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          write({ type: 'done' });
        }
        res.end();
        return;
      }

      if (req.method === 'GET') {
        serveStatic(res, staticDir, url.pathname);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendError(res, err);
    }
  });

  return { server, runtime };
}

export async function startSquirlServer(options: SquirlServerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4174;
  const { server } = createSquirlServer(options);
  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((resolveClose, reject) => server.close((err) => err ? reject(err) : resolveClose())),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const port = portArg ? Number(portArg.slice('--port='.length)) : 4174;
  const started = await startSquirlServer({ port });
  console.log(`squirl web UI listening at ${started.url}`);
}
