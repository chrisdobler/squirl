import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

export type PaletteAction = 'model' | 'import-chatgpt';

const ITEMS: { action: PaletteAction; label: string; description: string }[] = [
  { action: 'model', label: 'Switch model', description: 'Change the active LLM' },
  { action: 'import-chatgpt', label: 'Import ChatGPT', description: 'Load export folder or file into history' },
];

interface CommandPaletteProps {
  onSelect: (action: PaletteAction) => void;
  onClose: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ onSelect, onClose }) => {
  const [idx, setIdx] = useState(0);
  const { stdout } = useStdout();
  const width = Math.min(stdout.columns ?? 80, 50);

  useInput((_input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(ITEMS.length - 1, i + 1));
    if (key.return) onSelect(ITEMS[idx]!.action);
  });

  return (
    <Box
      position="absolute"
      flexDirection="column"
      width={width}
      marginLeft={Math.floor(((stdout.columns ?? 80) - width) / 2)}
      marginTop={2}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">Command Palette</Text>
      <Text> </Text>
      {ITEMS.map((item, i) => (
        <Box key={item.action} paddingLeft={1}>
          <Text color={i === idx ? 'cyan' : undefined}>
            {i === idx ? '❯ ' : '  '}
            <Text bold>{item.label}</Text>
            <Text dimColor>{'  '}{item.description}</Text>
          </Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>↑↓ navigate  enter select  esc close</Text>
    </Box>
  );
};
