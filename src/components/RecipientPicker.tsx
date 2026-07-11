import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Participant } from '../agents/types.js';
import { roomMembers } from '../agents/participants.js';

export const RecipientPicker: React.FC<{
  participants: Participant[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}> = ({ participants, selectedId, onSelect, onClose }) => {
  const members = roomMembers(participants);
  const [index, setIndex] = useState(Math.max(0, members.findIndex((p) => p.id === selectedId)));
  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow) setIndex((value) => Math.max(0, value - 1));
    else if (key.downArrow || key.tab) setIndex((value) => Math.min(members.length - 1, value + 1));
    else if (key.return && members[index]) onSelect(members[index]!.id);
  });
  return <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
    <Text bold>Select recipient</Text>
    {members.map((participant, i) => <Text key={participant.id} color={participant.color} inverse={i === index}>
      {i === index ? '❯ ' : '  '}@{participant.id}  <Text dimColor>{participant.status ?? 'ready'}</Text>
    </Text>)}
    <Text dimColor>↑/↓ choose · enter select · esc cancel</Text>
  </Box>;
};
