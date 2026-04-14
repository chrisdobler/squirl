import type { SearchResult } from './types.js';

export function formatMemorySystemMessage(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const header = 'The following are relevant excerpts from prior conversations that may provide useful context:\n';
  const entries = results.map((r) => {
    const date = r.turnPair.timestamp.slice(0, 10);
    return `---\n[${date}, source: ${r.turnPair.source}]\nUser: ${r.turnPair.userText}\nAssistant: ${r.turnPair.assistantText}`;
  });

  return header + '\n' + entries.join('\n\n');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(timestamp: string): string {
  const d = new Date(timestamp);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function formatMemoryInline(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const lines = results.map((r) => {
    const date = shortDate(r.turnPair.timestamp);
    const snippet = r.turnPair.userText.length > 50
      ? r.turnPair.userText.slice(0, 50) + '...'
      : r.turnPair.userText;
    return `  [${date}] ${snippet}`;
  });

  return `recalled ${results.length} memories\n${lines.join('\n')}`;
}
