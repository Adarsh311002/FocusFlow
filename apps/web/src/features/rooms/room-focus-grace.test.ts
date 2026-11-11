import { describe, expect, it } from 'vitest';

import { GRACE_DISPLAY_MS, graceSecondsLeft } from './room-focus-grace';

describe('graceSecondsLeft', () => {
  it('starts at the full 60 seconds and counts down by whole seconds, rounding up', () => {
    expect(graceSecondsLeft(10_000, 10_000)).toBe(60);
    expect(graceSecondsLeft(10_000, 10_001)).toBe(60);
    expect(graceSecondsLeft(10_000, 40_000)).toBe(30);
    expect(graceSecondsLeft(10_000, 69_001)).toBe(1);
  });

  it('is zero once the grace is over and never negative', () => {
    expect(graceSecondsLeft(10_000, 10_000 + GRACE_DISPLAY_MS)).toBe(0);
    expect(graceSecondsLeft(10_000, 500_000)).toBe(0);
  });

  it('never shows more than the grace when the client clock reads before the disconnect', () => {
    expect(graceSecondsLeft(10_000, 2_000)).toBe(60);
  });
});
