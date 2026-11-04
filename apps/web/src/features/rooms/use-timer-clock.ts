import { useEffect, useState } from 'react';

import { clock } from '../../lib/time-sync';

/**
 * The server's current time in ms, and whether the clock offset has been measured at all,
 * re-read once per second by a single interval. Nothing accumulates: each tick recomputes the
 * time from the clock, and the timer's `endsAtMs` does the rest, so a late tick only delays a
 * redraw. Before the first `time:sync` sample the offset is 0 and the display says so.
 */
export function useTimerClock(): { readonly nowMs: number; readonly synced: boolean } {
  const [reading, setReading] = useState(() => ({
    nowMs: clock.serverNow(),
    synced: clock.hasSamples(),
  }));
  useEffect(() => {
    const read = (): void => {
      setReading({ nowMs: clock.serverNow(), synced: clock.hasSamples() });
    };
    // A sample may have landed between the first render and this effect.
    read();
    const timer = setInterval(read, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return reading;
}
