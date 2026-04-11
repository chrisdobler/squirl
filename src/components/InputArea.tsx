import React from 'react';
import { Box, Text } from 'ink';
import { ChatInput } from './ChatInput.js';

interface InputAreaProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  focus?: boolean;
}

export const InputArea: React.FC<InputAreaProps> = React.memo(({ value, onChange, onSubmit, focus = true }) => (
  <Box
    borderStyle="single"
    borderTop={true}
    borderBottom={true}
    borderLeft={false}
    borderRight={false}
    paddingX={1}
  >
    <Text color="green" bold>{'🐿️  ❯  '}</Text>
    <ChatInput
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      placeholder="Type a message..."
      focus={focus}
    />
  </Box>
));
