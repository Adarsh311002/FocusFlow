import type { RoomId } from '@focus-flow/contracts';
import { useCallback, useEffect, useRef } from 'react';

import { useRealtimeClient } from '../realtime/realtime-provider';
import { getRoomLiveStore, useKnockStore } from './room-live-store';
import { socketErrorMessage } from './room-messages';

/**
 * Keeps the open room joined over the socket (M6): `room:join` goes out when the page opens
 * and again after every (re)connect and every `room:resync`, and each answer's snapshot
 * replaces the live state. The server decides everything: a refusal (`NOT_A_MEMBER`, a full
 * room) is shown as the server's answer, never papered over.
 *
 * Leaving the page does not send `room:leave` (M6: navigating inside the app does not leave
 * a room); only the explicit "Leave room" does.
 *
 * Returns `rejoin`, for a manual retry after a refusal that is worth trying again.
 */
export function useRoomSession(
  roomId: RoomId,
  enabled: boolean,
): { rejoin: () => void; refresh: () => void } {
  const client = useRealtimeClient();
  const joinRef = useRef<() => void>(() => undefined);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const store = getRoomLiveStore(roomId);
    let disposed = false;
    // Answers are applied only for the newest request on the current connection: a snapshot
    // from before a reconnect or a resync must not overwrite a fresher one.
    let generation = 0;
    let inFlight = false;

    const join = (force: boolean): void => {
      if (client.getStatus() !== 'connected' || (inFlight && !force)) {
        return;
      }
      generation += 1;
      const mine = generation;
      inFlight = true;
      store.getState().joining();
      void client.joinRoom(roomId).then((ack) => {
        if (disposed || mine !== generation) {
          return;
        }
        inFlight = false;
        if (ack.ok) {
          store.getState().joined(ack.snapshot);
          // Only the host receives the pending list; for everyone else it is absent.
          if (ack.snapshot.pendingKnocks !== undefined) {
            useKnockStore.getState().replaceIncoming(roomId, ack.snapshot.pendingKnocks);
          }
        } else {
          store
            .getState()
            .joinFailed(
              ack.error.code === 'NOT_A_MEMBER' ? 'not_member' : 'failed',
              socketErrorMessage(ack),
            );
        }
      });
    };
    joinRef.current = () => {
      join(true);
    };

    // Like rejoin, but does nothing while a join is already out (its answer replaces the state).
    refreshRef.current = () => {
      join(false);
    };

    const offConnected = client.onConnected(() => {
      join(false);
    });
    const offStatus = client.subscribe(() => {
      if (client.getStatus() === 'connected') {
        join(false);
      } else {
        generation += 1;
        inFlight = false;
        store.getState().disconnected();
      }
    });
    const offEvent = client.onRoomEvent((event) => {
      if (event.name === 'room:resync' && event.payload.roomId === roomId) {
        join(true);
      }
    });
    join(false);

    return () => {
      disposed = true;
      offConnected();
      offStatus();
      offEvent();
      joinRef.current = () => undefined;
      refreshRef.current = () => undefined;
    };
  }, [client, roomId, enabled]);

  const rejoin = useCallback(() => {
    joinRef.current();
  }, []);
  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);
  return { rejoin, refresh };
}
