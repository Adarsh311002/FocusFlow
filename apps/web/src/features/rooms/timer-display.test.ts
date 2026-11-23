import { describe, expect, it } from 'vitest';

import { timerView } from '../../test/fake-room-client';
import { formatClock } from '../focus/focus-time';
import {
  announcement,
  isFinishing,
  progressAt,
  remainingMsAt,
  remainingSecondsAt,
} from './timer-display';

const ROOM = '0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const running = (nowMs: number, durationMs = 1_500_000, elapsedBeforeMs = 0) =>
  timerView(ROOM, {
    status: 'running',
    durationMs,
    elapsedBeforeMs,
    segmentStartedAtMs: nowMs,
    endsAtMs: nowMs + durationMs - elapsedBeforeMs,
  });

describe('timer display arithmetic', () => {
  it('shows the full duration when idle, whatever the clock says', () => {
    const idle = timerView(ROOM);
    expect(remainingSecondsAt(idle, 0)).toBe(1_500);
    expect(remainingSecondsAt(idle, 9_999_999_999)).toBe(1_500);
    expect(isFinishing(idle, 9_999_999_999)).toBe(false);
  });

  it('counts a running timer down to endsAtMs on the server clock', () => {
    const timer = running(1_000_000);
    expect(remainingMsAt(timer, 1_000_000)).toBe(1_500_000);
    expect(remainingSecondsAt(timer, 1_000_000 + 60_000)).toBe(1_440);
    // Rounded up: 0:00 only appears when time is really up.
    expect(remainingSecondsAt(timer, timer.endsAtMs! - 400)).toBe(1);
    expect(remainingSecondsAt(timer, timer.endsAtMs!)).toBe(0);
  });

  it('accounts for time elapsed before the current running stretch', () => {
    const timer = running(5_000_000, 1_500_000, 600_000);
    expect(remainingSecondsAt(timer, 5_000_000)).toBe(900);
  });

  it('freezes a paused timer at what was left', () => {
    const paused = timerView(ROOM, { status: 'paused', elapsedBeforeMs: 420_000 });
    expect(remainingSecondsAt(paused, 1)).toBe(1_080);
    expect(remainingSecondsAt(paused, 99_999_999)).toBe(1_080);
  });

  it('clamps: never below zero, never above the duration (an early or late clock estimate)', () => {
    const timer = running(1_000_000);
    expect(remainingMsAt(timer, timer.endsAtMs! + 60_000)).toBe(0);
    expect(remainingMsAt(timer, 0)).toBe(1_500_000);
    const overElapsed = timerView(ROOM, { status: 'paused', elapsedBeforeMs: 2_000_000 });
    expect(remainingMsAt(overElapsed, 0)).toBe(0);
  });

  it('applies the clock offset the caller passes in (server time = client time + offset)', () => {
    const timer = running(1_000_000);
    const clientNow = 1_030_000;
    const offset = -10_000;
    expect(remainingSecondsAt(timer, clientNow + offset)).toBe(1_480);
  });

  it('is finishing only when running at zero', () => {
    const timer = running(1_000_000);
    expect(isFinishing(timer, timer.endsAtMs! - 1)).toBe(false);
    expect(isFinishing(timer, timer.endsAtMs!)).toBe(true);
    expect(isFinishing({ ...timer, status: 'paused' }, timer.endsAtMs!)).toBe(false);
  });

  it('reports progress in whole seconds', () => {
    const timer = running(1_000_000);
    expect(progressAt(timer, 1_000_000 + 375_000)).toEqual({
      elapsedSeconds: 375,
      totalSeconds: 1_500,
    });
    expect(progressAt(timerView(ROOM), 0)).toEqual({ elapsedSeconds: 0, totalSeconds: 1_500 });
  });

  it('formats hours as H:MM:SS and shorter times as MM:SS', () => {
    expect(formatClock(remainingSecondsAt(running(0, 3_725_000), 0))).toBe('1:02:05');
    expect(formatClock(remainingSecondsAt(running(0, 59_000), 0))).toBe('00:59');
  });

  it('words the announcement without the ticking time', () => {
    expect(announcement(timerView(ROOM, { phase: 'short_break', status: 'paused' }))).toBe(
      'Short break, paused.',
    );
  });
});
