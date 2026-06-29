import type { TurnPair } from './types.js';

/** How a turn-pair is rendered into the text that gets embedded. */
export interface ChunkOptions {
  /** Append `toolSummary` (when present) to the embedded text. */
  includeToolSummary: boolean;
  /** Hard character cap; text is truncated to this length. */
  maxChars: number;
  /** `user-assistant` embeds both turns; `user-only` embeds just the user text. */
  template: 'user-assistant' | 'user-only';
}

// Mirrors IngestQueue's production behavior: maxTokens 512 → floor(512 * 1.5) = 768 chars.
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  includeToolSummary: true,
  maxChars: 768,
  template: 'user-assistant',
};

// Control chars and unpaired surrogates break tokenizers; strip them.
const STRIP = /[\x00-\x08\x0b\x0c\x0e-\x1f]|[\uD800-\uDFFF]/g;

/** Build the text that represents a turn-pair for embedding. */
export function buildChunkText(pair: TurnPair, opts: ChunkOptions): string {
  let t = opts.template === 'user-only'
    ? pair.userText
    : `${pair.userText}\n${pair.assistantText}`;
  if (opts.includeToolSummary && pair.toolSummary) t += `\n${pair.toolSummary}`;
  t = t.replace(STRIP, '');
  if (t.length > opts.maxChars) t = t.slice(0, opts.maxChars);
  return t || ' ';
}
