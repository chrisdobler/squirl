import React from 'react';

import type { Participant } from '../agents/types.js';

export function AcornIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
    <path className="squirlAcornStem" d="M9.2 3.9c.1-1.2.8-2 2-2.6" />
    <path className="squirlAcornCap" d="M3.2 6.6c.6-2.4 2.6-3.8 5.3-3.8 2.6 0 4.5 1.4 5.1 3.8-2.9 1.3-7.4 1.3-10.4 0Z" />
    <path className="squirlAcornNut" d="M4.2 7.5c.5 3.9 2.1 6.4 4.3 6.4s3.8-2.5 4.2-6.4c-2.5.8-6 .8-8.5 0Z" />
  </svg>;
}

function CodexIcon() {
  return <svg className="participantKindIcon participantKindIcon--codex" viewBox="0 0 32 32" data-agent-icon="codex" aria-hidden="true">
    <g className="codexBlossom">
      <circle cx="16" cy="8" r="5.5" />
      <circle cx="22.5" cy="11" r="5.5" />
      <circle cx="24" cy="18" r="5.5" />
      <circle cx="19.5" cy="23.5" r="5.5" />
      <circle cx="12.5" cy="23" r="5.5" />
      <circle cx="8" cy="17.5" r="5.5" />
      <circle cx="9.5" cy="11" r="5.5" />
      <circle cx="16" cy="16" r="6.5" />
    </g>
    <path className="codexTerminal" d="m10.5 12.2 3.2 4.1-3.2 4.1M16.4 20.4h5.2" />
  </svg>;
}

function ClaudeIcon() {
  return <svg className="participantKindIcon participantKindIcon--claude" viewBox="0 0 248 248" data-agent-icon="claude-code" aria-hidden="true">
    <path d="M52.4 162.9 98.8 136.9l.8-2.3-.8-1.3h-2.3l-57.2-2.8-27.9-1.7-5.2-7 .5-3.4 4.7-3.2 84.3 6.7h3.8l.5-1.5-3.1-2.8-60.5-41-10.6-9.3-1.5-9.9 6.4-7.1 8.7.6 57.7 42.8 1.4-1-36.8-67.9-1.1-7.4 7.2-9.9 13.9 0 10.2 17.5 32 68.9 2.4 8.2h1.5l5-72.7 3.7-9 7.4-4.8 5.7 2.7 4.7 6.7-12.5 70.2h2l35.9-47.6 15.5-13.1h10.2l7.4 11.1-3.3 11.5-39.2 54.5.7 1.1 70.2-12 8.2 3.8.9 3.9-3.2 7.9-76.2 17.6-.4.3.5.7 67.3 4 7.8 5.1 4.6 6.3-.8 4.8-12 6-68.3-16h-1.8v1.1l56.3 51.2 1.3 5.7-3.2 4.5-3.3-.5-48.9-39.6h-1.3v1.7l28.5 51.6 1.1 10.6-1.7 3.4-6 2.1-6.5-1.2-38.7-59.4-1.4.9-6.7 71.2-3.1 3.7-7.1 2.7-6-4.5-3.2-7.3 14.6-73.3 1.7-6.2-.2-.4-1.4.2-38.7 48.3-16.9 18.1-4.1 1.7-7-3.7.6-6.5 44-64.8-.1-1.5-.5-.1-62.3 40.6-11.1 1.4-4.8-4.5.6-7.3 2.3-2.4Z" />
  </svg>;
}

function PiIcon() {
  return <svg className="participantKindIcon participantKindIcon--pi" viewBox="0 0 800 800" data-agent-icon="pi" aria-hidden="true">
    <path fillRule="evenodd" d="M165.3 165.3h352.1V400H400v117.4H282.7v117.3H165.3Zm117.4 117.4V400H400V282.7Z" />
    <path d="M517.4 400h117.3v234.7H517.4Z" />
  </svg>;
}

export function ParticipantKindIcon({ kind }: { kind: Participant['kind'] }) {
  if (kind === 'local-llm') return <AcornIcon className="participantKindIcon participantKindIcon--squirl" />;
  if (kind === 'claude-code') return <ClaudeIcon />;
  if (kind === 'codex') return <CodexIcon />;
  if (kind === 'pi') return <PiIcon />;
  return null;
}
