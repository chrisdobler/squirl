import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { defaultUiState, mergeUiState, normalizeUiState, type UiStatePatch, type UiStateV1 } from './ui-state.js';

export class UiStateStore {
  readonly path: string;
  constructor(path = join(homedir(), '.squirl', 'ui-state.json')) { this.path = path; }
  load(): UiStateV1 {
    try { return normalizeUiState(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch { return defaultUiState(); }
  }
  save(state: UiStateV1): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalizeUiState(state), null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }
  patch(patch: UiStatePatch): UiStateV1 {
    const next = mergeUiState(this.load(), patch);
    this.save(next);
    return next;
  }
}
