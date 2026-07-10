export type DiscKind = 'system' | 'files' | 'messages' | 'available';

/**
 * Allocate `total` discs (default 100) across the context window as a sequence:
 * system → files → messages → available. Each non-zero *used* bucket gets at least one
 * disc; the sequence is trimmed (on overflow) or padded with `available` to exactly `total`.
 *
 * Shared by the TUI ContextPicker and the web ContextView so the two stay identical.
 * A non-positive window (e.g. an unknown context window) yields all-available.
 */
export function computeContextDiscs(
  buckets: { system: number; files: number; messages: number },
  window: number,
  total = 100,
): DiscKind[] {
  if (!(window > 0)) return Array.from({ length: total }, () => 'available' as const);

  const perDisc = window / total;
  const discsFor = (tokens: number) => Math.max(tokens > 0 ? 1 : 0, Math.round(tokens / perDisc));

  const systemDiscs = discsFor(buckets.system);
  const filesDiscs = discsFor(buckets.files);
  const messagesDiscs = discsFor(buckets.messages);
  const availableDiscs = Math.max(0, total - (systemDiscs + filesDiscs + messagesDiscs));

  const discs: DiscKind[] = [];
  for (let i = 0; i < systemDiscs; i++) discs.push('system');
  for (let i = 0; i < filesDiscs; i++) discs.push('files');
  for (let i = 0; i < messagesDiscs; i++) discs.push('messages');
  for (let i = 0; i < availableDiscs; i++) discs.push('available');

  while (discs.length > total) discs.pop();
  while (discs.length < total) discs.push('available');
  return discs;
}
