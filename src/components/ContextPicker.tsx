import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { execSync } from 'child_process';
import { estimateTokens } from '../context/token-estimator.js';
import { computeContextDiscs, type DiscKind } from '../context/context-discs.js';
import { buildSystemPrompt } from '../context/system-prompt.js';
import { getModelConfig } from '../model-config.js';
import { platform } from 'os';
import type { Orchestrator } from '../orchestrator.js';
import type { Message } from '../types.js';
import type { ContextSnapshotDisc } from '../context/context-snapshot.js';

function ExplorerLine({ text, start, active }: { text: string; start: number; active: ContextSnapshotDisc | undefined }) {
  if (!active || active.start == null || active.end == null || active.end <= start || active.start >= start + text.length) {
    return <Text wrap="truncate-end">{text || ' '}</Text>;
  }
  const from = Math.max(0, active.start - start);
  const to = Math.min(text.length, active.end - start);
  return <Text wrap="truncate-end">{text.slice(0, from)}<Text backgroundColor="yellow" color="black">{text.slice(from, to) || ' '}</Text>{text.slice(to)}</Text>;
}

interface ContextPickerProps {
  orchestrator: Orchestrator;
  workingDir: string;
  messages: Message[];
  contextWindow: number;
  modelId: string;
  onClose: () => void;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const ContextPicker: React.FC<ContextPickerProps> = ({
  orchestrator,
  workingDir,
  messages,
  contextWindow,
  modelId,
  onClose,
}) => {
  const { stdout } = useStdout();
  const termWidth = stdout.columns ?? 80;

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [section, setSection] = useState<'context' | 'search'>('context');
  const [mode, setMode] = useState<'explorer' | 'files'>('explorer');
  const [selectedDisc, setSelectedDisc] = useState(0);
  const [documentScroll, setDocumentScroll] = useState(0);

  // Get context files from orchestrator
  const contextFiles = orchestrator.getContextFiles();
  const contextEntries = useMemo(() => Array.from(contextFiles.entries()), [contextFiles]);
  const snapshot = orchestrator.getContextSnapshot(messages, { id: modelId, label: modelId, provider: 'local', contextWindow });
  const documentLines = snapshot?.renderedDocument.split('\n') ?? [];
  const documentLineStarts = useMemo(() => {
    let offset = 0;
    return documentLines.map((line) => {
      const start = offset;
      offset += line.length + 1;
      return start;
    });
  }, [snapshot?.renderedDocument]);
  const documentRows = Math.max(5, (stdout.rows ?? 30) - 22);
  const usedDiscCount = snapshot?.discs.filter((disc) => disc.start != null).length ?? 0;

  // Git-tracked files
  const gitFiles = useMemo(() => {
    try {
      const output = execSync('git ls-files', { cwd: workingDir, encoding: 'utf-8' });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }, [workingDir]);

  // Fuzzy-filtered search results
  const searchResults = useMemo(() => {
    if (!query) return gitFiles.filter((f) => !contextFiles.has(f)).slice(0, 10);
    const pattern = new RegExp(query.split('').join('.*'), 'i');
    return gitFiles
      .filter((f) => !contextFiles.has(f) && pattern.test(f))
      .slice(0, 10);
  }, [query, gitFiles, contextFiles]);

  // Token buckets
  const tokenBuckets = useMemo(() => {
    const config = getModelConfig(modelId);
    const systemPrompt = buildSystemPrompt(
      {
        workingDir,
        date: new Date().toISOString().slice(0, 10),
        modelId,
        platform: platform(),
        shell: process.env.SHELL ?? 'unknown',
        supportsTools: config.supportsTools,
      },
      config.systemPromptStyle,
    );
    const systemTokens = estimateTokens(
      typeof systemPrompt.content === 'string' ? systemPrompt.content : '',
    );

    let filesTokens = 0;
    for (const [, content] of contextFiles) {
      filesTokens += estimateTokens(content);
    }

    let messagesTokens = 0;
    for (const msg of messages) {
      messagesTokens += estimateTokens(msg.content);
    }

    const used = systemTokens + filesTokens + messagesTokens;
    const available = Math.max(0, contextWindow - used);

    return { systemTokens, filesTokens, messagesTokens, available };
  }, [contextFiles, messages, contextWindow, modelId, workingDir]);

  // Current section list length
  const contextLen = contextEntries.length;
  const searchLen = searchResults.length;

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (input === 'e') {
      setMode((current) => current === 'explorer' ? 'files' : 'explorer');
      return;
    }

    if (mode === 'explorer') {
      if (key.leftArrow) setSelectedDisc((current) => Math.max(0, current - 1));
      else if (key.rightArrow) setSelectedDisc((current) => Math.min(Math.max(0, usedDiscCount - 1), current + 1));
      else if (key.upArrow) setSelectedDisc((current) => Math.max(0, current - 10));
      else if (key.downArrow) setSelectedDisc((current) => Math.min(Math.max(0, usedDiscCount - 1), current + 10));
      else if (key.return && snapshot?.discs[selectedDisc]?.start != null) {
        const offset = snapshot.discs[selectedDisc]!.start!;
        const targetLine = snapshot.renderedDocument.slice(0, offset).split('\n').length - 1;
        setDocumentScroll(Math.max(0, targetLine - 1));
      } else if (key.pageUp || input === 'k') {
        setDocumentScroll((current) => Math.max(0, current - documentRows));
      } else if (key.pageDown || input === 'j') {
        setDocumentScroll((current) => Math.min(Math.max(0, documentLines.length - documentRows), current + documentRows));
      }
      return;
    }

    if (key.tab) {
      if (section === 'context') {
        setSection('search');
        setSelectedIndex(0);
      } else {
        setSection('context');
        setSelectedIndex(0);
      }
      return;
    }

    if (key.upArrow) {
      if (selectedIndex > 0) {
        setSelectedIndex((i) => i - 1);
      } else if (section === 'search' && contextLen > 0) {
        // Cross into context section
        setSection('context');
        setSelectedIndex(contextLen - 1);
      }
      return;
    }

    if (key.downArrow) {
      if (section === 'context') {
        if (selectedIndex < contextLen - 1) {
          setSelectedIndex((i) => i + 1);
        } else {
          // Cross into search section
          setSection('search');
          setSelectedIndex(0);
        }
      } else {
        if (selectedIndex < searchLen - 1) {
          setSelectedIndex((i) => i + 1);
        }
      }
      return;
    }

    if (key.return) {
      if (section === 'search' && searchResults[selectedIndex]) {
        orchestrator.addContextFile(searchResults[selectedIndex]!);
        setSelectedIndex(Math.max(0, selectedIndex >= searchLen - 1 ? searchLen - 2 : selectedIndex));
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (section === 'context' && contextEntries[selectedIndex]) {
        orchestrator.removeContextFile(contextEntries[selectedIndex]![0]);
        setSelectedIndex(Math.max(0, selectedIndex >= contextLen - 1 ? contextLen - 2 : selectedIndex));
      } else if (section === 'search') {
        setQuery((q) => q.slice(0, -1));
      }
      return;
    }

    // Typing — add to search query
    if (input && !key.ctrl && !key.meta) {
      if (section !== 'search') {
        setSection('search');
        setSelectedIndex(0);
      }
      setQuery((q) => q + input);
    }
  });

  // Token grid rendering
  const { systemTokens, filesTokens, messagesTokens, available } = tokenBuckets;
  const usedTokens = systemTokens + filesTokens + messagesTokens;
  const gridWidth = 10;
  const rows = 10;
  const totalDiscs = gridWidth * rows;

  const DISC_STYLE: Record<DiscKind, { char: string; color: string }> = {
    system: { char: '■', color: 'blue' },
    files: { char: '■', color: 'yellow' },
    messages: { char: '■', color: 'green' },
    available: { char: '□', color: 'gray' },
  };
  const discKinds = snapshot
    ? snapshot.discs.map((disc) => disc.kind)
    : computeContextDiscs(
      { system: systemTokens, files: filesTokens, messages: messagesTokens },
      contextWindow,
      totalDiscs,
    );
  const discChars = discKinds.map((kind) => DISC_STYLE[kind]);

  const gridRows: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * gridWidth;
    const end = start + gridWidth;
    const rowDiscs = discChars.slice(start, end);
    gridRows.push(
      <Box key={`grid-row-${r}`} marginBottom={r < rows - 1 ? 1 : 0}>
        <Text>
          {rowDiscs.map((d, i) => (
            <Text key={i} color={d.color} inverse={mode === 'explorer' && start + i === selectedDisc && start + i < usedDiscCount}>{d.char}{'  '}</Text>
          ))}
        </Text>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      {/* Token grid header */}
      <Box paddingBottom={0}>
        <Text bold>
          Context {formatTokenCount(usedTokens)} / {formatTokenCount(contextWindow)} tokens
        </Text>
      </Box>

      {/* Token grid */}
      <Box flexDirection="column">
        {gridRows}
      </Box>

      {/* Legend */}
      <Box gap={2} paddingBottom={1} paddingTop={1}>
        <Text><Text color="blue">■</Text> system {formatTokenCount(systemTokens)}</Text>
        <Text><Text color="yellow">■</Text> files {formatTokenCount(filesTokens)}</Text>
        <Text><Text color="green">■</Text> messages {formatTokenCount(messagesTokens)}</Text>
        <Text><Text color="gray">□</Text> available {formatTokenCount(available)}</Text>
      </Box>

      {mode === 'explorer' ? (
        <Box flexDirection="column" flexGrow={1}>
          {!snapshot ? (
            <Box flexDirection="column" paddingY={1}>
              <Text bold>No context has been sent yet</Text>
              <Text dimColor>Send a message to capture the exact request supplied to the model.</Text>
            </Box>
          ) : (
            <>
              <Text dimColor>{snapshot.origin === 'exact' ? 'Exact request' : 'Preview'}  {snapshot.modelId}  ~{formatTokenCount(snapshot.approximateTokens)} tokens  {snapshot.capturedAt}</Text>
              {snapshot.discs[selectedDisc]?.start != null && (
                <Text color="cyan">
                  selected {snapshot.discs[selectedDisc]!.kind}  ~tokens {snapshot.discs[selectedDisc]!.tokenStart}-{snapshot.discs[selectedDisc]!.tokenEnd}
                </Text>
              )}
              <Box flexDirection="column" borderStyle="single" paddingX={1} height={documentRows + 2}>
                {documentLines.slice(documentScroll, documentScroll + documentRows).map((line, index) => (
                  <ExplorerLine
                    key={`${documentScroll}-${index}`}
                    text={line}
                    start={documentLineStarts[documentScroll + index] ?? 0}
                    active={snapshot.discs[selectedDisc]}
                  />
                ))}
              </Box>
            </>
          )}
          <Text dimColor>e files  arrows select dot  enter jump  j/k or pgup/pgdn scroll  esc close</Text>
        </Box>
      ) : <>
      {/* Current context */}
      <Box flexDirection="column" paddingBottom={1}>
        <Text bold>Current context:</Text>
        {contextEntries.length === 0 ? (
          <Box paddingLeft={2}>
            <Text dimColor>No files in context</Text>
          </Box>
        ) : (
          contextEntries.map(([path, content], i) => {
            const isSelected = section === 'context' && i === selectedIndex;
            const tokens = estimateTokens(content);
            return (
              <Box key={path} paddingLeft={1}>
                <Text color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? '▸ ' : '  '}
                  {path}
                </Text>
                <Text dimColor>  (~{formatTokenCount(tokens)} tokens)</Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Search */}
      <Box flexDirection="column">
        <Box>
          <Text bold>Search: </Text>
          <Text color="cyan">{query}</Text>
          <Text color="cyan">_</Text>
        </Box>
        {searchResults.map((file, i) => {
          const isSelected = section === 'search' && i === selectedIndex;
          return (
            <Box key={file} paddingLeft={2}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '▸ ' : '  '}
                {file}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Help */}
      <Box paddingTop={1}>
        <Text dimColor>
          e explorer  tab switch section  ↑↓ navigate  enter add  backspace remove/delete char  esc close
        </Text>
      </Box>
      </>}
    </Box>
  );
};
