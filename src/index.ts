#!/usr/bin/env node

import { Command } from 'commander';
import { version } from '../package.json';

const program = new Command();

program
  .name('squirl')
  .description('squirl CLI')
  .version(version);

program.parse();
