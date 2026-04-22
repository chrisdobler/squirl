import React, { useRef, useLayoutEffect } from 'react';
import { Box, Text, useStdout, measureElement } from 'ink';
import type { Message, UserMessage, AssistantMessage, ToolMessage } from '../types.js';
import type { DOMElement } from 'ink';

interface MessageListProps {
  messages: Message[];
  showThinking?: boolean;
  scrollOffset?: number;
  onMaxScroll?: (max: number) => void;
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

// --- Markdown Rendering ---

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const inlineRegex = /(\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(<Text key={key++} bold>{match[2]}</Text>);
    } else if (match[3]) {
      nodes.push(<Text key={key++} color="yellow">{match[3]}</Text>);
    } else if (match[4]) {
      nodes.push(<Text key={key++} dimColor>{match[4]}</Text>);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function renderMarkdown(content: string): React.ReactNode {
  if (!content) return null;

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++;
      elements.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={0}>
          {lang && <Text dimColor>{lang}</Text>}
          <Text color="yellow">{codeLines.join('\n')}</Text>
        </Box>
      );
      continue;
    }

    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      elements.push(
        <Box key={key++}>
          <Text bold color="cyan">{headerMatch[2]}</Text>
        </Box>
      );
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      elements.push(
        <Box key={key++} paddingLeft={1}>
          <Text dimColor>{'│ '}{renderInlineMarkdown(line.slice(2))}</Text>
        </Box>
      );
      i++;
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*])\s+(.+)/);
    if (listMatch) {
      const indent = Math.floor(listMatch[1]!.length / 2);
      elements.push(
        <Box key={key++} paddingLeft={indent * 2}>
          <Text>{'  • '}{renderInlineMarkdown(listMatch[3]!)}</Text>
        </Box>
      );
      i++;
      continue;
    }

    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (numMatch) {
      const indent = Math.floor(numMatch[1]!.length / 2);
      elements.push(
        <Box key={key++} paddingLeft={indent * 2}>
          <Text>{'  '}{numMatch[2]}. {renderInlineMarkdown(numMatch[3]!)}</Text>
        </Box>
      );
      i++;
      continue;
    }

    if (line.trim() === '') {
      elements.push(<Box key={key++}><Text> </Text></Box>);
      i++;
      continue;
    }

    elements.push(
      <Box key={key++}>
        <Text>{renderInlineMarkdown(line)}</Text>
      </Box>
    );
    i++;
  }

  return <Box flexDirection="column">{elements}</Box>;
}

// --- Message Rows ---

function MessageRow({ msg, showThinking, dimmed }: { msg: Message; showThinking: boolean; dimmed: boolean }): React.ReactElement {
  if (dimmed) {
    switch (msg.role) {
      case 'user':
        return (
          <Box marginBottom={1} paddingX={2}>
            <Text dimColor>{'❯ '}{msg.content}</Text>
          </Box>
        );
      case 'assistant': {
        const { visibleContent } = parseThinkBlocks(msg.content);
        return (
          <Box flexDirection="column" marginBottom={1} paddingX={2}>
            <Text dimColor>assistant</Text>
            <Box paddingLeft={2}><Text dimColor>{visibleContent}</Text></Box>
          </Box>
        );
      }
      case 'tool':
        return (
          <Box flexDirection="column" paddingX={1} marginBottom={1} marginX={2}>
            <Text dimColor>tool: {msg.toolName}</Text>
            <Text dimColor>{msg.content}</Text>
          </Box>
        );
    }
  }

  switch (msg.role) {
    case 'user':
      return (
        <Box marginBottom={1} paddingX={2}>
          <Text color="cyan" bold>{'❯ '}</Text>
          <Text>{msg.content}</Text>
        </Box>
      );
    case 'assistant': {
      const { thinkContent, visibleContent, thinkingInProgress } = parseThinkBlocks(msg.content);
      const hasThinking = thinkContent.length > 0 || thinkingInProgress;
      return (
        <Box flexDirection="column" marginBottom={1} paddingX={2}>
          <Text dimColor>assistant</Text>
          {hasThinking && (
            <Box flexDirection="column" paddingLeft={2}>
              {showThinking ? (
                <>
                  <Text dimColor>{'▼ thinking'}</Text>
                  <Box paddingLeft={2}>
                    <Text dimColor color="gray">{thinkContent}{thinkingInProgress ? <Text color="cyan">_</Text> : null}</Text>
                  </Box>
                </>
              ) : (
                <Text dimColor>
                  {'▶ thinking'}
                  {thinkingInProgress
                    ? <Text color="cyan">...</Text>
                    : ` (~${Math.ceil(thinkContent.length / 4)} tokens) `}
                  {!thinkingInProgress && <Text dimColor>(expand ctrl+v)</Text>}
                </Text>
              )}
            </Box>
          )}
          <Box paddingLeft={2}>
            {renderMarkdown(visibleContent)}
            {msg.isStreaming && !thinkingInProgress ? <Text color="cyan">_</Text> : null}
          </Box>
        </Box>
      );
    }
    case 'tool':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginBottom={1}
          marginX={2}
        >
          <Text color="yellow" bold>tool: {msg.toolName}</Text>
          <Text dimColor>{msg.content}</Text>
        </Box>
      );
  }
}

export const MessageList: React.FC<MessageListProps & { dimmed?: boolean }> = ({ messages, showThinking = false, scrollOffset = 0, onMaxScroll, dimmed = false }) => {
  const { stdout } = useStdout();
  const boxHeight = (stdout.rows ?? 24) - 9;   // header(4) + input(3) + status(2)
  const availableRows = boxHeight - 2;           // paddingY(1) top + bottom
  const contentRef = useRef<DOMElement>(null);
  const maxScrollRef = useRef(0);

  useLayoutEffect(() => {
    if (contentRef.current) {
      const { height } = measureElement(contentRef.current);
      const max = Math.max(0, height - availableRows);
      maxScrollRef.current = max;
      onMaxScroll?.(max);
    }
  });

  const clampedScroll = Math.min(scrollOffset, maxScrollRef.current);
  const maxScroll = maxScrollRef.current;

  // Scrollbar: compute thumb position and size
  const trackHeight = availableRows;
  const hasScrollbar = maxScroll > 0;
  const thumbSize = hasScrollbar ? Math.max(1, Math.min(trackHeight, Math.round(trackHeight * (availableRows / (availableRows + maxScroll))))) : trackHeight;
  // scrollOffset=0 is bottom, maxScroll is top — invert for scrollbar (top=0)
  const scrollFraction = hasScrollbar ? 1 - (clampedScroll / maxScroll) : 1;
  const thumbTop = Math.max(0, Math.min(trackHeight - thumbSize, Math.round(scrollFraction * (trackHeight - thumbSize))));

  const scrollbar: string[] = [];
  for (let i = 0; i < trackHeight; i++) {
    scrollbar.push(i >= thumbTop && i < thumbTop + thumbSize ? '█' : '│');
  }

  return (
    <Box flexDirection="row" height={boxHeight}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingY={1}>
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-(maxScroll - clampedScroll)}>
          {messages.map((msg) => (
            <MessageRow key={msg.id} msg={msg} showThinking={showThinking} dimmed={dimmed} />
          ))}
        </Box>
      </Box>
      <Box flexDirection="column" paddingY={1} width={1}>
        <Text dimColor>{scrollbar.join('\n')}</Text>
      </Box>
    </Box>
  );
};
