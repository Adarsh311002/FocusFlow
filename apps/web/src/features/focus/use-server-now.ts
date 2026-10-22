import { useEffect, useState } from 'react';

import { clock } from '../../lib/time-sync';

/**
 * The server's current time in ms, re-read once per second. The browser only displays
 * countdowns from it (docs/architecture/focus-timing-protocol.md, "Client display"); the
 * server alone decides that a session ended.
 */
export function useServerNowMs(): number {
  const [now, setNow] = useState(() => clock.serverNow());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(clock.serverNow());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/**
 * Whether the clock offset has been measured at least once. Before that the offset is 0, so
 * a client clock that is off shows a wrong countdown; the display says so rather than
 * implying precision. The first sample arrives after the socket connects, so this polls on
 * the same one-second beat.
 */
export function useClockSynced(): boolean {
  const [synced, setSynced] = useState(() => clock.hasSamples());
  useEffect(() => {
    const timer = setInterval(() => {
      setSynced(clock.hasSamples());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return synced;
}
