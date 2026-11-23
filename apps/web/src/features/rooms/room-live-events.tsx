import type { RoomId } from '@focus-flow/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { RealtimeClient } from '../realtime/realtime-client';
import { roomKeys } from './room-keys';
import { getRoomLiveStore, resetRoomLiveState, useKnockStore } from './room-live-store';

/**
 * Feeds the live room stores from the socket for as long as the user is signed in, wherever
 * they are in the app: a host learns of a knock on the dashboard, a requester of the answer
 * on the Rooms page. Events are validated by the realtime client; here they only update
 * live state or ask TanStack Query to re-read what the server owns (membership, settings).
 * The stores are emptied when the user changes or signs out.
 */
export function RoomLiveEvents({ client, userId }: { client: RealtimeClient; userId: string }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (queryKey: readonly unknown[]): void => {
      void queryClient.invalidateQueries({ queryKey });
    };
    // A "you were removed" notice outlives the page that would show it. When the user becomes
    // a member again before seeing it, it must not block the room they now belong to.
    const forgetRemoval = (roomId: RoomId): void => {
      const store = getRoomLiveStore(roomId);
      if (store.getState().removed !== null) {
        store.getState().reset();
      }
    };
    const off = client.onRoomEvent((event) => {
      switch (event.name) {
        case 'room:presence:joined':
          getRoomLiveStore(event.payload.roomId).getState().presenceJoined(event.payload.user);
          return;
        case 'room:presence:left':
          getRoomLiveStore(event.payload.roomId).getState().presenceLeft(event.payload.userId);
          return;
        case 'room:timer:state':
          // Applied only if newer than the held state; the store enforces it (RT2).
          getRoomLiveStore(event.payload.roomId).getState().timerReceived(event.payload.timer);
          return;
        case 'room:focus:participants':
          // Applied by run id; the store drops events about a run it already replaced.
          getRoomLiveStore(event.payload.roomId)
            .getState()
            .focusParticipantsReceived(event.payload);
          return;
        case 'room:chat:message':
          getRoomLiveStore(event.payload.roomId).getState().chatReceived(event.payload);
          return;
        case 'room:member:joined':
          if (event.payload.member.userId === userId) {
            forgetRemoval(event.payload.roomId);
          }
          invalidate(roomKeys.members(userId, event.payload.roomId));
          return;
        case 'room:member:removed': {
          const { roomId, userId: removedId, reason } = event.payload;
          if (removedId === userId) {
            // This user's membership is gone: the room is no longer theirs to read.
            getRoomLiveStore(roomId).getState().memberRemoved(reason);
            useKnockStore.getState().replaceIncoming(roomId, []);
            queryClient.removeQueries({ queryKey: roomKeys.detail(userId, roomId) });
            queryClient.removeQueries({ queryKey: roomKeys.members(userId, roomId) });
            invalidate(roomKeys.list(userId));
          } else {
            getRoomLiveStore(roomId).getState().presenceLeft(removedId);
            invalidate(roomKeys.members(userId, roomId));
          }
          return;
        }
        case 'room:settings:updated':
          invalidate(roomKeys.detail(userId, event.payload.roomId));
          return;
        case 'room:knock:received': {
          const { roomId, requester, expiresAtMs } = event.payload;
          useKnockStore.getState().knockReceived(roomId, { ...requester, expiresAtMs });
          return;
        }
        case 'room:knock:removed':
          useKnockStore.getState().knockRemoved(event.payload.roomId, event.payload.userId);
          return;
        case 'room:knock:resolved': {
          const { roomId, outcome } = event.payload;
          useKnockStore.getState().outgoingResolved(roomId, outcome);
          if (outcome === 'approved') {
            // A removal recorded earlier (for example the undone half of an approval that was
            // compensated) is not true of this membership.
            forgetRemoval(roomId);
            // They are a member now: the new room belongs in "My rooms".
            invalidate(roomKeys.list(userId));
          }
          return;
        }
        case 'room:resync':
          // Answered by whoever has the room open (use-room-session.ts); nothing to keep here.
          return;
      }
    });
    return () => {
      off();
      resetRoomLiveState();
    };
  }, [client, queryClient, userId]);

  return null;
}
