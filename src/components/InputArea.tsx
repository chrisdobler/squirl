import React from 'react';
import { Box, Text } from 'ink';
import { ChatInput } from './ChatInput.js';

interface InputAreaProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  focus?: boolean;
  recipientId?: string;
}

export const InputArea: React.FC<InputAreaProps> = React.memo(({ value, onChange, onSubmit, focus = true, recipientId = 'squirl' }) => (
  <Box
    borderStyle="single"
    borderTop={true}
    borderBottom={true}
    borderLeft={false}
    borderRight={false}
    paddingX={1}
  >
    <Text color="green" bold>{`[@${recipientId} ▾] ❯ `}</Text>
    <ChatInput
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      placeholder="Type a message..."
      focus={focus}
    />
  </Box>
));
