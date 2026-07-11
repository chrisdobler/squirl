export interface MemoryLookupItem {
  date: string;
  snippet: string;
}

export interface MemoryLookupSummary {
  count: number;
  items: MemoryLookupItem[];
}

export function parseMemoryLookup(content: string): MemoryLookupSummary | null {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = lines[0]?.match(/^recalled\s+(\d+)\s+memor(?:y|ies)$/i);
  if (!header) return null;
  const items = lines.slice(1).map((line) => {
    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    return match ? { date: match[1]!, snippet: match[2]! } : { date: '', snippet: line };
  });
  return { count: Number.parseInt(header[1]!, 10), items };
}
