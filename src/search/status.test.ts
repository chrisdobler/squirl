import { describe, it, expect, vi } from 'vitest';
import { StatusEmitter } from './status.js';

describe('StatusEmitter', () => {
  it('starts idle', () => {
    expect(new StatusEmitter().current).toEqual({ phase: 'idle', pending: 0 });
  });

  it('notifies listeners on update', () => {
    const e = new StatusEmitter();
    const cb = vi.fn();
    e.on(cb);
    e.update({ phase: 'embedding', pending: 3 });
    expect(cb).toHaveBeenCalledWith({ phase: 'embedding', pending: 3 });
    expect(e.current.phase).toBe('embedding');
  });

  it('removes listener on off()', () => {
    const e = new StatusEmitter();
    const cb = vi.fn();
    e.on(cb);
    e.off(cb);
    e.update({ phase: 'indexing', pending: 1 });
    expect(cb).not.toHaveBeenCalled();
  });
});
