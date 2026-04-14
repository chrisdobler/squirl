import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { getCommands } from '../commands/registry.js';
import { IndexStatus } from './IndexStatus.js';
import type { StatusEmitter } from '../search/status.js';

interface StatusBarProps {
  tokenCount?: number;
  contextWindow?: number;
  isStreaming?: boolean;
  toolStatus?: string;
  tokensPerSecond?: number;
  modelName?: string;
  workingDir?: string;
  commandQuery?: string | null;
  commandIndex?: number;
  statusEmitter?: StatusEmitter | null;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export const StatusBar: React.FC<StatusBarProps> = React.memo(({ tokenCount = 0, contextWindow = 0, isStreaming = false, toolStatus = '', tokensPerSecond = 0, modelName = '', workingDir = '', commandQuery = null, commandIndex = 0, statusEmitter = null }) => {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

  // Show command completions when in slash command mode
  if (commandQuery !== null) {
    const matches = getCommands().filter((c) => c.name.startsWith(commandQuery));

    return (
      <Box flexDirection="column" paddingX={2} width={width}>
        {matches.length > 0
          ? matches.map((c, i) => (
              <Text key={c.name}>
                <Text color={i === commandIndex ? 'cyan' : undefined} bold={i === commandIndex}>/{c.name}</Text>
                <Text dimColor>  {c.description}</Text>
              </Text>
            ))
          : <Text dimColor>No matching commands</Text>
        }
      </Box>
    );
  }

  return (
    <Box paddingX={2} width={width} justifyContent="space-between">
      <Text dimColor>
        {toolStatus ? <Text color="yellow">{toolStatus}{'  '}</Text> : null}
        {isStreaming ? 'esc cancel  ' : ''}
        ctrl+c exit{'  '}ctrl+p menu{'  '}ctrl+v thinking{'  '}
        context: {formatTokens(tokenCount)}/{formatTokens(contextWindow)}
        {'  '}{tokensPerSecond} t/s
      </Text>
      <Box>
        {statusEmitter && <IndexStatus statusEmitter={statusEmitter} />}
        <Text dimColor>{'  '}{modelName}{'  '}{workingDir}</Text>
      </Box>
    </Box>
  );
});
