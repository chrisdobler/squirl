import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquirlRuntime } from './runtime.js';
import type { ChatEvent, EvalEvent, EvalRunRequest } from './types.js';

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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, err: unknown, status = 500): void {
  sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
  const runtime = new SquirlRuntime(options.workingDir ?? process.cwd());
  const staticDir = options.staticDir ?? resolve(__dirname, '../../dist-web');

  const server = createServer(async (req, res) => {
    const url = parseUrl(req);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        });
        res.end();
        return;
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        sendJson(res, 200, runtime.getState());
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, await runtime.updateConfig(body as never));
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

      if (url.pathname === '/api/cancel' && req.method === 'POST') {
        sendJson(res, 200, { ok: runtime.cancel() });
        return;
      }

      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req) as { message?: string };
        const write = createEventWriter(res);
        try {
          await runtime.chat(body.message ?? '', write);
        } catch (err) {
          write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          write({ type: 'done' });
        }
        res.end();
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
