import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { AgentStatus, Participant } from '../agents/types.js';
import { roomMembers } from '../agents/participants.js';

interface RoomRosterProps {
  participants: Participant[];
  onClose: () => void;
}

function statusGlyph(status?: AgentStatus): { glyph: string; dim: boolean } {
  switch (status) {
    case 'ready': return { glyph: '●', dim: false };
    case 'busy':
    case 'starting': return { glyph: '◐', dim: false };
    case 'stopped':
    case 'error': return { glyph: '×', dim: true };
    default: return { glyph: '●', dim: false };
  }
}

export const RoomRoster: React.FC<RoomRosterProps> = ({ participants, onClose }) => {
  const { stdout } = useStdout();
  const width = Math.min((stdout.columns ?? 80) - 4, 72);
  const members = roomMembers(participants);

  useInput((input, key) => {
    if (key.escape || key.return || input === 'q') onClose();
  });

  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" paddingTop={2}>
      <Box flexDirection="column" width={width} borderStyle="round" borderColor="white" paddingX={1}>
        <Box
          paddingBottom={1}
          borderStyle="single"
          borderBottom={true}
          borderTop={false}
          borderLeft={false}
          borderRight={false}
        >
          <Text bold>◈ In this room ({members.length})</Text>
        </Box>

        {members.map((p) => {
          const { glyph, dim } = statusGlyph(p.status);
          const handle = p.kind === 'local-llm' ? 'local' : `@${p.id}`;
          return (
            <Box key={p.id} paddingTop={1} flexDirection="column">
              <Box>
                <Text color={p.color} dimColor={dim}>{glyph} </Text>
                <Text bold color={p.color}>{p.label}</Text>
                <Text dimColor>{`  ${handle}  ${p.status ?? 'ready'}`}</Text>
              </Box>
              {p.mode ? <Box paddingLeft={2}><Text dimColor>{p.mode}</Text></Box> : null}
            </Box>
          );
        })}

        <Box paddingTop={1}>
          <Text dimColor>esc/enter close · /agent add to invite · /agent rename to rename · tab to choose recipient</Text>
        </Box>
      </Box>
    </Box>
  );
};
