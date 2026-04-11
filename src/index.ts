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

program.parse();
