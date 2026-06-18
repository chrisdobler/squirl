// @mention routing. A mention only counts as a routing target if its handle matches a known
// participant id; unknown @tokens are left as plain text. Leading mentions are stripped from
// the prompt so the addressed agent doesn't see "@cc" noise; mid-sentence mentions are kept.

export interface ParsedMentions {
  /** Known participant ids addressed, in first-seen order, deduped. */
  targets: string[];
  /** Prompt with leading known-mention tokens removed. */
  cleaned: string;
}

const MENTION_RE = /(^|\s)@([a-zA-Z0-9_-]+)/g;
const LEADING_TOKEN_RE = /^\s*@([a-zA-Z0-9_-]+)\s*/;

export function parseMentions(input: string, knownIds: string[]): ParsedMentions {
  // Match handles case-insensitively but resolve to the canonical id (e.g. "@CC" -> "cc").
  const canonical = new Map(knownIds.map((id) => [id.toLowerCase(), id]));
  const targets: string[] = [];

  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(input)) !== null) {
    const id = canonical.get(match[2]!.toLowerCase());
    if (id && !targets.includes(id)) targets.push(id);
  }

  // Strip the leading run of known-mention tokens only.
  let cleaned = input;
  let token: RegExpMatchArray | null;
  while ((token = cleaned.match(LEADING_TOKEN_RE)) !== null && canonical.has(token[1]!.toLowerCase())) {
    cleaned = cleaned.slice(token[0].length);
  }

  return { targets, cleaned: cleaned.trim() };
}
