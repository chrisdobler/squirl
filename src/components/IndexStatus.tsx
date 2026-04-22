import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import type { StatusEmitter } from '../search/status.js';
import type { IngestStatus } from '../search/types.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface IndexStatusProps {
  statusEmitter: StatusEmitter | null;
}

export const IndexStatus: React.FC<IndexStatusProps> = React.memo(({ statusEmitter }) => {
  const [status, setStatus] = useState<IngestStatus>({ phase: 'idle', pending: 0 });
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!statusEmitter) return;
    setStatus(statusEmitter.current);
    const listener = (s: IngestStatus) => setStatus(s);
    statusEmitter.on(listener);
    return () => { statusEmitter.off(listener); };
  }, [statusEmitter]);

  useEffect(() => {
    if (status.phase === 'idle' || status.phase === 'error') return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [status.phase]);

  if (status.phase === 'idle') return null;

  if (status.phase === 'error') {
    const msg = (status as any).error ? `: ${(status as any).error}` : '';
    return <Text color="red">! index error{msg}</Text>;
  }

  return (
    <Text color="cyan">
      {SPINNER_FRAMES[frame]} {status.phase} ({status.pending})
    </Text>
  );
});
