import {
  type RoomId,
  type RoomTimerCommandRequest,
  roomTimerRejectionDetailsSchema,
} from '@focus-flow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRealtimeClient } from '../realtime/realtime-provider';
import { getRoomLiveStore } from './room-live-store';
import { TIMER_RESTORED, timerErrorMessage } from './timer-messages';

export type TimerCommand = RoomTimerCommandRequest['command'];

export type TimerCommandsApi = {
  /** True from sending a command until its acknowledgement; every control is disabled meanwhile. */
  readonly pending: boolean;
  readonly error: string | null;
  readonly send: (command: TimerCommand) => Promise<boolean>;
  readonly clearError: () => void;
};

/**
 * Sends the host's timer commands (RT5) one at a time. The answer's timer goes through the
 * same version rule as events, so a slow acknowledgement never replaces a newer state; a
 * rejection for a stale version or an impossible transition carries the current timer in its
 * details (RT6) and the display catches up from it. The browser decides nothing itself.
 */
export function useTimerCommands(roomId: RoomId, refresh: () => void): TimerCommandsApi {
  const client = useRealtimeClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback(
    async (command: TimerCommand): Promise<boolean> => {
      // A ref, not the state: two clicks in one tick must not send two commands.
      if (inFlight.current) {
        return false;
      }
      inFlight.current = true;
      setPending(true);
      setError(null);
      const ack = await client.sendTimerCommand(roomId, command);
      inFlight.current = false;
      const store = getRoomLiveStore(roomId).getState();
      let message: string | null = null;
      if (ack.ok) {
        store.timerReceived(ack.timer);
      } else {
        const details = roomTimerRejectionDetailsSchema.safeParse(ack.error.details);
        message = timerErrorMessage(ack);
        if (details.success) {
          const held = store.timer;
          if (held !== null && details.data.timer.version < held.version) {
            // We hold a higher version than the server: its timer was restored (RT2). The
            // version rule would ignore this, so ask for the authoritative snapshot, once.
            message = TIMER_RESTORED;
            refresh();
          } else {
            store.timerReceived(details.data.timer);
          }
        }
      }
      if (mounted.current) {
        setPending(false);
        setError(message);
      }
      return ack.ok;
    },
    [client, roomId, refresh],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { pending, error, send, clearError };
}
