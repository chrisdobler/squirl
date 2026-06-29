// One-command split dev: the API runs under `tsx watch` (auto-restarts on backend changes),
// while Vite runs as its own long-lived process (its HMR handles client changes and it is never
// restarted, so there's no port churn / orphaned-Vite pile-up on the front end).
//
// Both children are spawned directly from node_modules/.bin (no pnpm/tsx-watch wrapper around
// Vite), so each is a single, cleanly-killable process — the whole point vs. `tsx watch dev.ts`,
// where Vite is a grandchild the watcher can't reliably reap.
import { spawn, type ChildProcess } from 'node:child_process';

const bin = (name: string) => new URL(`../../node_modules/.bin/${name}`, import.meta.url).pathname;
const apiPort = process.env.SQUIRL_API_PORT ?? '4174';
const apiUrl = `http://127.0.0.1:${apiPort}`;

// Backend: restarts itself on changes to its import graph; client files aren't in that graph.
const api = spawn(bin('tsx'), ['watch', 'src/web/dev-api.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SQUIRL_API_PORT: apiPort },
});

// Frontend: stable Vite dev server, told where the API lives. `--strictPort` makes a busy 5173
// fail loudly (a leftover process) instead of silently crawling up to 5174, 5175, ...
const vite = spawn(bin('vite'), ['--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_SQUIRL_API_BASE: apiUrl },
});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  api.kill('SIGTERM');
  vite.kill('SIGTERM');
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// If either long-lived process dies, tear the other down so the command exits cleanly.
const onChildExit = (child: ChildProcess, name: string) => child.on('exit', (code) => {
  if (!shuttingDown) console.error(`[dev-split] ${name} exited (${code ?? 0}); shutting down.`);
  shutdown(code ?? 0);
});
onChildExit(api, 'api');
onChildExit(vite, 'vite');
