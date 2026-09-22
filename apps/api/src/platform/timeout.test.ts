import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTimeout } from './timeout.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value when the promise settles before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1_000, 'fallback');

    expect(result).toBe('ok');
  });

  it('resolves the fallback when the promise never settles', async () => {
    const hanging = new Promise<string>(() => undefined);
    const pending = withTimeout(hanging, 1_000, 'fallback');

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe('fallback');
  });

  it('does not resolve the fallback before the deadline', async () => {
    const hanging = new Promise<string>(() => undefined);
    let settled = false;
    void withTimeout(hanging, 1_000, 'fallback').then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);

    expect(settled).toBe(false);
  });

  it('clears its timer once the promise wins, so nothing is left pending', async () => {
    await withTimeout(Promise.resolve('ok'), 1_000, 'fallback');

    expect(vi.getTimerCount()).toBe(0);
  });
});
