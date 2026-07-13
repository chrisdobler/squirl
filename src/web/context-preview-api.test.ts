import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSquirlServer } from './server.js';
import type { ParticipantContextPreview } from './types.js';

describe('participant context preview API', () => {
  const servers: Array<ReturnType<typeof createSquirlServer>['server']> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  async function start(preview: ParticipantContextPreview | null) {
    const runtime = { getParticipantContextPreview: () => preview } as unknown as ReturnType<typeof createSquirlServer>['runtime'];
    const instance = createSquirlServer({ runtime, uiStatePath: join(mkdtempSync(join(tmpdir(), 'squirl-preview-api-')), 'state.json') });
    servers.push(instance.server);
    await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    return `http://127.0.0.1:${address.port}`;
  }

  it('returns only the sanitized preview contract', async () => {
    const preview: ParticipantContextPreview = {
      participantId: 'codex', modelId: 'gpt-test', source: 'codex-session', fidelity: 'inspected', capturedAt: 'now',
      matrixMode: 'usage',
      usedTokens: 10, contextWindow: 100, buckets: { system: 2, memory: 0, files: 3, messages: 5 },
      discs: Array.from({ length: 100 }, (_, index) => index < 10 ? 'messages' : 'available'),
    };
    const base = await start(preview);
    const response = await fetch(`${base}/api/participants/codex/context-preview`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ preview });
    expect(JSON.stringify(body)).not.toMatch(/renderedDocument|artifactPath|private prompt/);
  });

  it('returns 404 for a participant outside the room', async () => {
    const base = await start(null);
    const response = await fetch(`${base}/api/participants/missing/context-preview`);
    expect(response.status).toBe(404);
  });
});
