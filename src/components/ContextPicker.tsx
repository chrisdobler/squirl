import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { execSync } from 'child_process';
import { estimateTokens } from '../context/token-estimator.js';
import { buildSystemPrompt } from '../context/system-prompt.js';
import { getModelConfig } from '../model-config.js';
import { platform } from 'os';
import type { Orchestrator } from '../orchestrator.js';
import type { Message } from '../types.js';

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

  // Get context files from orchestrator
  const contextFiles = orchestrator.getContextFiles();
  const contextEntries = useMemo(() => Array.from(contextFiles.entries()), [contextFiles]);

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
  const tokensPerDisc = contextWindow / totalDiscs;

  const systemDiscs = Math.max(systemTokens > 0 ? 1 : 0, Math.round(systemTokens / tokensPerDisc));
  const filesDiscs = Math.max(filesTokens > 0 ? 1 : 0, Math.round(filesTokens / tokensPerDisc));
  const messagesDiscs = Math.max(messagesTokens > 0 ? 1 : 0, Math.round(messagesTokens / tokensPerDisc));
  const usedDiscs = systemDiscs + filesDiscs + messagesDiscs;
  const availableDiscs = Math.max(0, totalDiscs - usedDiscs);

  const discChars: Array<{ char: string; color: string }> = [];
  for (let i = 0; i < systemDiscs; i++) discChars.push({ char: '■', color: 'blue' });
  for (let i = 0; i < filesDiscs; i++) discChars.push({ char: '■', color: 'yellow' });
  for (let i = 0; i < messagesDiscs; i++) discChars.push({ char: '■', color: 'green' });
  for (let i = 0; i < availableDiscs; i++) discChars.push({ char: '□', color: 'gray' });

  // Trim or pad to totalDiscs
  while (discChars.length > totalDiscs) discChars.pop();
  while (discChars.length < totalDiscs) discChars.push({ char: '□', color: 'gray' });

  const gridRows: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * gridWidth;
    const end = start + gridWidth;
    const rowDiscs = discChars.slice(start, end);
    gridRows.push(
      <Box key={`grid-row-${r}`} marginBottom={r < rows - 1 ? 1 : 0}>
        <Text>
          {rowDiscs.map((d, i) => (
            <Text key={i} color={d.color}>{d.char}{'  '}</Text>
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
          tab switch section  ↑↓ navigate  enter add  backspace remove/delete char  esc close
        </Text>
      </Box>
    </Box>
  );
};
