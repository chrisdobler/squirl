import { spawn } from 'node:child_process';
import { startSquirlServer } from './server.js';

const api = await startSquirlServer({ port: 4174 });
console.log(`squirl API listening at ${api.url}`);

const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5173'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_SQUIRL_API_BASE: api.url,
  },
});

const shutdown = async () => {
  vite.kill('SIGTERM');
  await api.close();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

vite.on('exit', (code) => {
  void api.close().finally(() => process.exit(code ?? 0));
});
