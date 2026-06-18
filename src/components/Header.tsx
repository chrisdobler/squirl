import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Participant } from '../agents/types.js';
import { roomMembers } from '../agents/participants.js';

interface HeaderProps {
  participants?: Participant[];
}

export const Header: React.FC<HeaderProps> = ({ participants }) => {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;
  const count = participants ? roomMembers(participants).length : 0;

  return (
    <Box
      flexDirection="column"
      width={width}
    >
      <Box paddingX={1} paddingTop={2} justifyContent="space-between">
        <Text bold color="white">squirl</Text>
        {count > 0 ? <Text dimColor>{`◈ ${count} in room`}</Text> : null}
      </Box>
      <Box
        borderStyle="single"
        borderBottom={true}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      />
    </Box>
  );
};
