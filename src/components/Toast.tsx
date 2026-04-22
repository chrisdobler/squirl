import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'error' | 'info';
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  const { stdout } = useStdout();
  const maxWidth = Math.min(stdout.columns ?? 80, 60);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts
      .filter((t) => t.type !== 'error')
      .map((t) => setTimeout(() => onDismiss(t.id), 8000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <Box
      position="absolute"
      flexDirection="column"
      marginLeft={(stdout.columns ?? 80) - maxWidth - 2}
      marginTop={1}
      gap={1}
    >
      {toasts.slice(0, 3).map((toast) => (
        <Box
          key={toast.id}
          width={maxWidth}
          borderStyle="round"
          borderColor={toast.type === 'error' ? 'red' : 'cyan'}
          paddingX={1}
        >
          <Text color={toast.type === 'error' ? 'red' : 'cyan'} wrap="wrap">
            {toast.type === 'error' ? '! ' : ''}{toast.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
};
