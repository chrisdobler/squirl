import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../types.js';

interface MessageListProps {
  messages: Message[];
  height?: number;
  showThinking?: boolean;
  scrollOffset?: number;
  onMaxScroll?: (max: number) => void;
  rewindTargetMessageId?: string | null;
  rewindCandidateIds?: Set<string>;
  isRewindMode?: boolean;
  onScrollOffsetRequest?: (offset: number) => void;
}

export interface ScrollbarLayout {
  trackHeight: number;
  thumbTop: number;
  thumbSize: number;
  rows: string[];
}

export interface ViewportLine {
  key: string;
  text: string;
  messageId?: string;
  color?: 'cyan' | 'yellow' | 'gray';
  dim?: boolean;
  bold?: boolean;
}

export interface ViewportLayout<T> {
  totalRows: number;
  maxScroll: number;
  clampedScroll: number;
  viewportTop: number;
  rows: T[];
}

export function viewportRowsForHeight(height: number): number {
  return Math.max(1, height - 2);
}

export function computeScrollbarLayout(availableRows: number, maxScroll: number, scrollOffset: number): ScrollbarLayout {
  const trackHeight = Math.max(1, availableRows);
  const safeMaxScroll = Math.max(0, maxScroll);
  const clampedScroll = Math.max(0, Math.min(scrollOffset, safeMaxScroll));
  const hasScrollbar = safeMaxScroll > 0;
  const thumbSize = hasScrollbar
    ? Math.max(1, Math.min(trackHeight, Math.round(trackHeight * (trackHeight / (trackHeight + safeMaxScroll)))))
    : trackHeight;
  const scrollFraction = hasScrollbar ? 1 - (clampedScroll / safeMaxScroll) : 1;
  const thumbTop = Math.max(0, Math.min(trackHeight - thumbSize, Math.round(scrollFraction * (trackHeight - thumbSize))));
  const rows = Array.from({ length: trackHeight }, (_value, i) => (
    hasScrollbar && i >= thumbTop && i < thumbTop + thumbSize ? '█' : ' '
  ));

  return { trackHeight, thumbTop, thumbSize, rows };
}

export function computeViewportLayout<T>(
  rows: T[],
  availableRows: number,
  scrollOffset: number,
  blankRow: T,
): ViewportLayout<T> {
  const safeAvailableRows = Math.max(1, availableRows);
  const totalRows = rows.length;
  const maxScroll = Math.max(0, totalRows - safeAvailableRows);
  const clampedScroll = Math.max(0, Math.min(scrollOffset, maxScroll));
  const viewportTop = Math.max(0, maxScroll - clampedScroll);
  const visibleRows = rows.slice(viewportTop, viewportTop + safeAvailableRows);

  while (visibleRows.length < safeAvailableRows) {
    visibleRows.push(blankRow);
  }

  return { totalRows, maxScroll, clampedScroll, viewportTop, rows: visibleRows };
}

function parseThinkBlocks(content: string): { thinkContent: string; visibleContent: string; thinkingInProgress: boolean } {
  const thinkRegex = /<think>([\s\S]*?)(<\/think>|$)/g;
  let thinkContent = '';
  let thinkingInProgress = false;

  const visibleContent = content.replace(thinkRegex, (_match, inner: string, closing: string) => {
    thinkContent += inner;
    if (!closing || closing === '') thinkingInProgress = true;
    return '';
  }).trim();

  if (content.includes('<think>') && !content.includes('</think>')) {
    thinkingInProgress = true;
  }

  return { thinkContent: thinkContent.trim(), visibleContent, thinkingInProgress };
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*(.+?)\*/g, '$1');
}

function markdownToViewportLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  const out: string[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      inCode = !inCode;
      if (inCode && lang) out.push(`  ${lang}`);
      continue;
    }

    if (inCode) {
      out.push(`  ${line}`);
      continue;
    }

    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      out.push(stripInlineMarkdown(headerMatch[2]!));
      continue;
    }

    if (line.startsWith('> ')) {
      out.push(`│ ${stripInlineMarkdown(line.slice(2))}`);
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*])\s+(.+)/);
    if (listMatch) {
      const indent = Math.floor(listMatch[1]!.length / 2);
      out.push(`${' '.repeat(indent * 2)}• ${stripInlineMarkdown(listMatch[3]!)}`);
      continue;
    }

    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (numMatch) {
      const indent = Math.floor(numMatch[1]!.length / 2);
      out.push(`${' '.repeat(indent * 2)}${numMatch[2]}. ${stripInlineMarkdown(numMatch[3]!)}`);
      continue;
    }

    if (line.trim() === '') {
      out.push(' ');
      continue;
    }

    out.push(stripInlineMarkdown(line));
  }

  return out;
}

function buildMessageLines({
  messages,
  showThinking,
  dimmed,
  isRewindMode,
  rewindCandidateIds,
  rewindTargetMessageId,
}: {
  messages: Message[];
  showThinking: boolean;
  dimmed: boolean;
  isRewindMode: boolean;
  rewindCandidateIds: Set<string>;
  rewindTargetMessageId: string | null;
}): ViewportLine[] {
  const rows: ViewportLine[] = [];

  const add = (line: Omit<ViewportLine, 'key'>, index: number) => {
    rows.push({ key: `${line.messageId ?? 'blank'}:${index}:${rows.length}`, ...line });
  };

  for (const msg of messages) {
    const isRewindCandidate = rewindCandidateIds.has(msg.id);
    const isRewindTarget = rewindTargetMessageId === msg.id;
    const muted = dimmed || (isRewindMode && !isRewindCandidate);
    const base = { messageId: msg.id, dim: muted };

    if (msg.role === 'user') {
      const prefix = isRewindMode ? (isRewindCandidate ? '○ ' : '  ') : '❯ ';
      const contentLines = msg.content.split('\n');
      if (isRewindTarget) {
        add({ ...base, text: '↩ rewind target', color: 'cyan', bold: true }, 0);
      }
      contentLines.forEach((line, index) => {
        add({
          ...base,
          text: `${index === 0 ? prefix : '  '}${line}`,
          color: muted ? undefined : 'cyan',
          bold: !muted && !isRewindCandidate,
        }, index + 1);
      });
      add({ text: ' ', messageId: msg.id }, contentLines.length + 1);
      continue;
    }

    if (msg.role === 'assistant') {
      const { thinkContent, visibleContent, thinkingInProgress } = parseThinkBlocks(msg.content);
      const hasThinking = thinkContent.length > 0 || thinkingInProgress;
      add({ ...base, text: 'assistant', dim: true }, 0);

      if (hasThinking) {
        if (showThinking) {
          add({ ...base, text: '  ▼ thinking', dim: true }, 1);
          markdownToViewportLines(thinkContent).forEach((line, index) => {
            add({ ...base, text: `    ${line}`, color: 'gray', dim: true }, index + 2);
          });
          if (thinkingInProgress) add({ ...base, text: '    _', color: 'cyan' }, 3);
        } else {
          const status = thinkingInProgress ? '...' : ` (~${Math.ceil(thinkContent.length / 4)} tokens) (expand ctrl+v)`;
          add({ ...base, text: `  ▶ thinking${status}`, dim: true }, 1);
        }
      }

      const bodyLines = markdownToViewportLines(visibleContent);
      if (msg.isStreaming && !thinkingInProgress) {
        if (bodyLines.length === 0) bodyLines.push('_');
        else bodyLines[bodyLines.length - 1] = `${bodyLines[bodyLines.length - 1]} _`;
      }
      bodyLines.forEach((line, index) => {
        add({ ...base, text: `  ${line}` }, index + 10);
      });
      add({ text: ' ', messageId: msg.id }, bodyLines.length + 20);
      continue;
    }

    add({ ...base, text: `tool: ${msg.toolName}`, color: muted ? undefined : 'yellow', bold: !muted }, 0);
    msg.content.split('\n').forEach((line, index) => {
      add({ ...base, text: `  ${line}`, dim: true }, index + 1);
    });
    add({ text: ' ', messageId: msg.id }, 100);
  }

  return rows;
}

export const MessageList: React.FC<MessageListProps & { dimmed?: boolean }> = ({
  messages,
  height = 15,
  showThinking = false,
  scrollOffset = 0,
  onMaxScroll,
  dimmed = false,
  rewindTargetMessageId = null,
  rewindCandidateIds = new Set(),
  isRewindMode = false,
  onScrollOffsetRequest,
}) => {
  const boxHeight = Math.max(1, height);
  const availableRows = viewportRowsForHeight(boxHeight);
  const rows = useMemo(() => buildMessageLines({
    messages,
    showThinking,
    dimmed,
    isRewindMode,
    rewindCandidateIds,
    rewindTargetMessageId,
  }), [messages, showThinking, dimmed, isRewindMode, rewindCandidateIds, rewindTargetMessageId]);
  const viewport = computeViewportLayout<ViewportLine>(
    rows,
    availableRows,
    scrollOffset,
    { key: 'blank', text: ' ' },
  );

  useEffect(() => {
    onMaxScroll?.(viewport.maxScroll);

    if (isRewindMode && rewindTargetMessageId && onScrollOffsetRequest) {
      const targetTop = rows.findIndex((line) => line.messageId === rewindTargetMessageId);
      if (targetTop < 0) return;
      let targetBottom = targetTop + 1;
      while (targetBottom < rows.length && rows[targetBottom]!.messageId === rewindTargetMessageId) {
        targetBottom++;
      }

      const viewportBottom = viewport.viewportTop + availableRows;
      let desiredViewportTop: number | null = null;
      if (targetTop < viewport.viewportTop) {
        desiredViewportTop = targetTop;
      } else if (targetBottom > viewportBottom) {
        desiredViewportTop = Math.max(0, targetBottom - availableRows);
      }
      if (desiredViewportTop !== null) {
        const nextOffset = Math.max(0, Math.min(viewport.maxScroll, viewport.maxScroll - desiredViewportTop));
        if (nextOffset !== scrollOffset) onScrollOffsetRequest(nextOffset);
      }
    }
  });

  const scrollbar = computeScrollbarLayout(availableRows, viewport.maxScroll, viewport.clampedScroll);

  return (
    <Box flexDirection="row" height={boxHeight}>
      <Box flexDirection="column" flexGrow={1} paddingY={1}>
        {viewport.rows.map((line, i) => (
          <Text
            key={`${line.key}:${i}`}
            color={line.color}
            dimColor={line.dim}
            bold={line.bold}
            wrap="truncate-end"
          >
            {line.text}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" paddingY={1} width={2}>
        {scrollbar.rows.map((row, i) => (
          <Text key={i} dimColor>{` ${row}`}</Text>
          ))}
      </Box>
    </Box>
  );
};
