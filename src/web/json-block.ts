const JSON_LANGS = new Set(['json', 'json-l', 'jsonl', 'jsonld']);

export function isJsonLanguage(lang: string | undefined): boolean {
  if (!lang) return false;
  return JSON_LANGS.has(lang.trim().toLowerCase());
}

export function isJsonLinesLanguage(lang: string): boolean {
  const normalized = lang.trim().toLowerCase();
  return normalized === 'json-l' || normalized === 'jsonl';
}

export function parseJsonBlock(content: string, lang: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (isJsonLinesLanguage(lang)) {
    const values: unknown[] = [];
    for (const line of trimmed.split('\n')) {
      const row = line.trim();
      if (!row) continue;
      try {
        values.push(JSON.parse(row));
      } catch {
        return null;
      }
    }
    return values.length ? values : null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function formatPrimitive(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function truncateText(text: string, max = 72): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function summarizeJsonEntry(value: unknown, index: number): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `[${index}] ${formatPrimitive(value)}`;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.timestamp === 'string' && record.message && typeof record.message === 'object' && !Array.isArray(record.message)) {
    const message = record.message as Record<string, unknown>;
    const role = typeof message.role === 'string' ? message.role : 'message';
    const content = typeof message.content === 'string' ? truncateText(message.content.replace(/\s+/g, ' ').trim()) : '';
    return content ? `${record.timestamp} · ${role} · ${content}` : `${record.timestamp} · ${role}`;
  }

  const keys = Object.keys(record);
  if (keys.length === 1) {
    return `[${index}] ${keys[0]}: ${truncateText(formatPrimitive(record[keys[0]]))}`;
  }

  return `[${index}] {${keys.length} keys}`;
}

interface HastLike {
  value?: string;
  children?: HastLike[];
}

export type { HastLike };

export function extractCodeText(node: HastLike | undefined): string {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  if (!node.children?.length) return '';
  return node.children.map(extractCodeText).join('');
}
