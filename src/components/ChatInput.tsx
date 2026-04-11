import React, { useRef, useReducer } from 'react';
import { Text, useInput } from 'ink';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
  mask,
}) => {
  const cursorRef = useRef(value.length);
  const pasteRegionRef = useRef<{ start: number; length: number } | null>(null);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  // Clamp cursor if value shrunk externally (e.g. parent cleared it)
  if (cursorRef.current > value.length) {
    cursorRef.current = value.length;
  }
  // Clear paste region if value was cleared externally
  if (value.length === 0) {
    pasteRegionRef.current = null;
  }

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) {
      return;
    }

    // Let app-level ctrl shortcuts pass through without inserting characters
    if (key.ctrl && (input === 'c' || input === 'v' || input === 'p')) {
      return;
    }

    if (key.return) {
      onSubmit(value);
      cursorRef.current = 0;
      pasteRegionRef.current = null;
      return;
    }

    const cursor = cursorRef.current;
    let nextValue = value;
    let nextCursor = cursor;

    // --- Navigation ---

    if (key.leftArrow) {
      if (key.ctrl || key.meta) {
        nextCursor = wordBoundaryLeft(value, cursor);
      } else {
        nextCursor = Math.max(0, cursor - 1);
      }
    } else if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        nextCursor = wordBoundaryRight(value, cursor);
      } else {
        nextCursor = Math.min(value.length, cursor + 1);
      }
    }

    // Ctrl+A: beginning of line
    else if (key.ctrl && input === 'a') {
      nextCursor = 0;
    }

    // Ctrl+E: end of line
    else if (key.ctrl && input === 'e') {
      nextCursor = value.length;
    }

    // --- Deletion ---

    // Ctrl+W / Alt+Backspace: delete word backward
    else if ((key.ctrl && input === 'w') || (key.meta && (key.backspace || key.delete))) {
      const boundary = wordBoundaryLeft(value, cursor);
      nextValue = value.slice(0, boundary) + value.slice(cursor);
      nextCursor = boundary;
    }

    // Ctrl+U: delete to start of line
    else if (key.ctrl && input === 'u') {
      nextValue = value.slice(cursor);
      nextCursor = 0;
      pasteRegionRef.current = null;
    }

    // Ctrl+K: delete to end of line
    else if (key.ctrl && input === 'k') {
      nextValue = value.slice(0, cursor);
    }

    // Regular backspace / delete (macOS sends \x7f for Backspace, which Ink maps to key.delete)
    else if (key.backspace || key.delete) {
      if (cursor > 0) {
        nextValue = value.slice(0, cursor - 1) + value.slice(cursor);
        nextCursor = cursor - 1;
      }
    }

    // --- Character input ---
    else {
      nextValue = value.slice(0, cursor) + input + value.slice(cursor);
      nextCursor = cursor + input.length;
      if (input.length > 1) {
        pasteRegionRef.current = { start: cursor, length: input.length };
      }
    }

    // Clamp
    nextCursor = Math.max(0, Math.min(nextValue.length, nextCursor));

    if (nextValue !== value) {
      cursorRef.current = nextCursor;
      onChange(nextValue);
    } else if (nextCursor !== cursor) {
      cursorRef.current = nextCursor;
      forceRender();
    }
  }, { isActive: focus });

  // --- Rendering ---
  const displayValue = mask ? mask.repeat(value.length) : value;
  const cursor = cursorRef.current;

  if (!focus) {
    return <Text dimColor>{displayValue || placeholder}</Text>;
  }

  if (displayValue.length === 0) {
    const ph = placeholder || ' ';
    return <Text><Text inverse>{ph[0]}</Text><Text dimColor>{ph.slice(1)}</Text></Text>;
  }

  const PASTE_COLLAPSE_THRESHOLD = 40;
  const pr = pasteRegionRef.current;
  const collapsed = pr && pr.length > PASTE_COLLAPSE_THRESHOLD && pr.start + pr.length <= displayValue.length;

  if (collapsed) {
    const pasteEnd = pr.start + pr.length;
    const pastedText = displayValue.slice(pr.start, pasteEnd);
    const lines = pastedText.split('\n').length;
    const label = lines > 1
      ? `[pasted ${pr.length} chars, ${lines} lines]`
      : `[pasted ${pr.length} chars]`;

    const beforePaste = displayValue.slice(0, pr.start);
    const afterPaste = displayValue.slice(pasteEnd);

    // Cursor position relative to the collapsed view
    if (cursor <= pr.start) {
      // Cursor is before the paste
      const atCursor = cursor < pr.start ? displayValue[cursor] : null;
      const beforeCursor = displayValue.slice(0, cursor);
      const betweenCursorAndPaste = atCursor ? displayValue.slice(cursor + 1, pr.start) : displayValue.slice(cursor, pr.start);
      return (
        <Text>
          {beforeCursor}
          {atCursor ? <Text inverse>{atCursor}</Text> : <Text inverse>{' '}</Text>}
          {betweenCursorAndPaste}
          <Text color="yellow" dimColor>{label}</Text>
          {afterPaste}
        </Text>
      );
    } else {
      // Cursor is after the paste (typical case: user typed after pasting)
      const afterPasteCursorPos = cursor - pasteEnd;
      const atCursor = cursor < displayValue.length ? displayValue[cursor] : null;
      const beforeCursor = afterPaste.slice(0, afterPasteCursorPos);
      const afterCursor = afterPaste.slice(afterPasteCursorPos + (atCursor ? 1 : 0));
      return (
        <Text>
          {beforePaste}
          <Text color="yellow" dimColor>{label}</Text>
          {beforeCursor}
          {atCursor ? <Text inverse>{atCursor}</Text> : <Text inverse>{' '}</Text>}
          {afterCursor}
        </Text>
      );
    }
  }

  const atCursor = cursor < displayValue.length ? displayValue[cursor] : null;
  const before = displayValue.slice(0, cursor);
  const after = displayValue.slice(cursor + (atCursor ? 1 : 0));

  return (
    <Text>
      {before}
      {atCursor ? <Text inverse>{atCursor}</Text> : <Text inverse>{' '}</Text>}
      {after}
    </Text>
  );
};

// --- Word boundary helpers ---

function wordBoundaryLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && /\s/.test(text[i]!)) i--;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

function wordBoundaryRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}
