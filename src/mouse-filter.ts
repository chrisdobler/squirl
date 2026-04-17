import { Transform } from 'node:stream';
import { EventEmitter } from 'node:events';

const MOUSE_SEQ_RE = /\x1b\[<\s*(\d+)\s*;\s*(\d+)\s*;\s*(\d+)\s*([Mm])/g;

// Matches a trailing partial escape sequence that may continue in the next chunk
const PARTIAL_SEQ_RE = /\x1b(\[(<(\s*\d+\s*;?){0,2}\s*\d*\s*)?)?$/;

export const mouseEvents = new EventEmitter();

const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

export function enableMouseTracking(): void {
  process.stdout.write(ENABLE_MOUSE);
}

export function disableMouseTracking(): void {
  process.stdout.write(DISABLE_MOUSE);
}

let pendingBuffer = '';

/**
 * Transform stream that strips SGR mouse escape sequences from stdin data
 * and emits parsed wheel events via the mouseEvents emitter.
 *
 * Must be piped between process.stdin and Ink's render so that mouse
 * sequences never reach Ink's keypress parser.
 */
export const mouseFilter = new Transform({
  transform(chunk: Buffer, _encoding, callback) {
    const str = pendingBuffer + chunk.toString('utf-8');
    pendingBuffer = '';

    // Parse and emit wheel events from complete sequences
    MOUSE_SEQ_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MOUSE_SEQ_RE.exec(str)) !== null) {
      const button = parseInt(match[1]!, 10);
      const isPress = match[4] === 'M';
      if (isPress) {
        if (button === 64) mouseEvents.emit('wheel', 'up');
        else if (button === 65) mouseEvents.emit('wheel', 'down');
      }
    }

    // Strip complete mouse sequences
    const cleaned = str.replace(MOUSE_SEQ_RE, '');

    // Check for a trailing partial escape sequence that may span chunks
    const partialMatch = PARTIAL_SEQ_RE.exec(cleaned);
    if (partialMatch) {
      // Buffer the partial sequence for the next chunk
      pendingBuffer = partialMatch[0];
      const passThrough = cleaned.slice(0, partialMatch.index);
      if (passThrough.length > 0) {
        this.push(Buffer.from(passThrough, 'utf-8'));
      }
    } else if (cleaned.length > 0) {
      this.push(Buffer.from(cleaned, 'utf-8'));
    }
    callback();
  },

  flush(callback) {
    // Push any remaining buffered data on stream end
    if (pendingBuffer.length > 0) {
      this.push(Buffer.from(pendingBuffer, 'utf-8'));
      pendingBuffer = '';
    }
    callback();
  },
});

// Proxy TTY properties so Ink treats this stream like a real stdin
Object.defineProperty(mouseFilter, 'isTTY', { value: process.stdin.isTTY });

(mouseFilter as any).setRawMode = function (mode: boolean) {
  if (typeof (process.stdin as any).setRawMode === 'function') {
    (process.stdin as any).setRawMode(mode);
  }
  return mouseFilter;
};

(mouseFilter as any).ref = function () {
  process.stdin.ref();
  return mouseFilter;
};

(mouseFilter as any).unref = function () {
  process.stdin.unref();
  return mouseFilter;
};
