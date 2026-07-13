import React from 'react';
import { PARTICIPANT_COLOR_VALUE } from '../agents/participants.js';
import type { Participant } from '../agents/types.js';

export function ParticipantIdentity({ participant, text, marker = true, className }: {
  participant: Participant;
  text?: React.ReactNode;
  marker?: boolean;
  className?: string;
}) {
  const color = PARTICIPANT_COLOR_VALUE[participant.color];
  return <>
    {marker && <span className="participantMark" style={{ backgroundColor: color }} aria-hidden="true" />}
    {text != null && <span className={className} style={{ color }}>{text}</span>}
  </>;
}
