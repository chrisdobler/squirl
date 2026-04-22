#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('squirl')
  .description('squirl CLI')
  .version(version);

program.action(async () => {
  const { launchApp } = await import('./launcher.js');
  await launchApp();
});

program
  .command('import <source> <path>')
  .description('Import chat history from external sources (e.g., chatgpt). Path can be a file or directory.')
  .option('--embedder <type>', 'Embedding provider (openai or local)', 'openai')
  .option('--store <type>', 'Store type (local-chroma)', 'local-chroma')
  .option('--chroma-url <url>', 'Chroma server URL', 'http://localhost:8000')
  .action(async (source: string, path: string, opts: any) => {
    const { getImporter } = await import('./search/importers/index.js');
    const { createEmbedder } = await import('./search/embedders/index.js');
    const { createVectorStore } = await import('./search/stores/index.js');
    const { IngestQueue } = await import('./search/ingest-queue.js');
    const { StatusEmitter } = await import('./search/status.js');

    const importer = getImporter(source);
    const embedder = createEmbedder({ type: opts.embedder });
    const store = await createVectorStore({ type: opts.store, chromaUrl: opts.chromaUrl });
    const status = new StatusEmitter();

    let count = 0;
    status.on((s) => {
      process.stdout.write(`\r${s.phase} (${s.pending} pending, ${count} total)`);
    });

    const queue = new IngestQueue(embedder, store, status);

    for await (const pair of importer.parse(path)) {
      queue.enqueue(pair);
      count++;
    }

    await queue.flush();
    await store.close();
    console.log(`\nImported ${count} turn-pairs from ${source}.`);
  });

program.parse();
