import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAlive, watchParent } from './parent-watch.js';

afterEach(() => vi.useRealTimers());

describe('isAlive', () => {
  it("o'zimizning pid tirik; ESRCH -> yo'q; EPERM -> tirik", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(1, () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); })).toBe(false);
    expect(isAlive(1, () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); })).toBe(true);
  });
});

describe('watchParent', () => {
  it("ota o'lganda onGone bir marta chaqiriladi", () => {
    vi.useFakeTimers();
    let alive = true;
    const gone = vi.fn();
    watchParent(123, gone, 1000, () => alive);
    vi.advanceTimersByTime(3000);
    expect(gone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(5000);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("stop funksiyasi kuzatuvni to'xtatadi", () => {
    vi.useFakeTimers();
    const gone = vi.fn();
    const stop = watchParent(123, gone, 1000, () => false);
    stop();
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });
});
