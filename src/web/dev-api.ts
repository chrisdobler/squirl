// API-only dev entry. Runs just the squirl HTTP API so it can be supervised by `tsx watch`
// (only the backend restarts on change). Pair it with a separately-run Vite dev server — see
// dev-split.ts, or run `pnpm exec vite` yourself with VITE_SQUIRL_API_BASE pointed here.
import { startSquirlServer } from './server.js';

const port = Number(process.env.SQUIRL_API_PORT ?? 4174);
const api = await startSquirlServer({ port });
console.log(`squirl API listening at ${api.url}`);

// Close the listener on exit so `tsx watch` can rebind the port immediately on the next restart.
const shutdown = async () => {
  await api.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
