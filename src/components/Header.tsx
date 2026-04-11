import React from 'react';
import { Box, Text, useStdout } from 'ink';

export const Header: React.FC = () => {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

  return (
    <Box
      flexDirection="column"
      width={width}
    >
      <Box paddingX={1} paddingTop={1}>
        <Text bold color="white">squirl</Text>
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
