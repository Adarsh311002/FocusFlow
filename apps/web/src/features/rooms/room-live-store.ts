import type {
  KnockView,
  PresenceUser,
  RoomChatMessageEvent,
  RoomId,
  RoomMemberRemovedEvent,
  RoomSnapshot,
  TimerView,
  UserId,
} from '@focus-flow/contracts';
import { create, createStore, type StoreApi, useStore } from 'zustand';

// Live room state (decision M11): presence, chat and the join status of a room are fed only
// by the join snapshot and socket events, one store per room. Nothing here is persisted and
// nothing is derived from a client claim: durable data (the room, its members) is TanStack
// Query. Every store is reset when the user signs out or another user signs in
// (room-live-events.tsx).

/** Messages kept in memory per room; older ones scroll away for good (chat is temporary, D7). */
export const MAX_CHAT_MESSAGES = 200;

export type JoinStatus = 'idle' | 'joining' | 'joined' | 'not_member' | 'failed';

export type ChatEntry = {
  /** The sender's own id for this message; the key that makes retries and echoes one entry. */
  readonly clientMessageId: string;
  readonly messageId: string | null;
  readonly sender: { readonly userId: UserId; readonly displayName: string };
  readonly body: string;
  readonly sentAtMs: number | null;
  readonly status: 'pending' | 'sent' | 'failed';
  readonly error: string | null;
};

export type RoomLiveState = {
  readonly roomId: RoomId;
  readonly joinStatus: JoinStatus;
  readonly joinError: string | null;
  /** One entry per person, whatever the number of their tabs (server-side presence is per user). */
  readonly presence: readonly PresenceUser[];
  readonly messages: readonly ChatEntry[];
  /**
   * The shared room timer (Phase 7), as the server last told us; `null` until the first
   * snapshot. Fed only by the join snapshot (authoritative, replaces whatever is held, RT2)
   * and by newer-versioned `room:timer:state` events.
   */
  readonly timer: TimerView | null;
  /** Set when this user's membership ended (removed by the host, or left elsewhere). */
  readonly removed: RoomMemberRemovedEvent['reason'] | null;
  readonly joining: () => void;
  readonly joined: (snapshot: RoomSnapshot) => void;
  readonly joinFailed: (status: 'not_member' | 'failed', message: string) => void;
  /** The socket dropped: the room is no longer joined, and presence can no longer be trusted. */
  readonly disconnected: () => void;
  readonly presenceJoined: (user: PresenceUser) => void;
  readonly presenceLeft: (userId: UserId) => void;
  /**
   * A `room:timer:state` event, or the current timer from a rejected command's details: applied
   * only when its version is greater than the held one. Other rooms' timers are ignored.
   */
  readonly timerReceived: (timer: TimerView) => void;
  readonly chatPending: (entry: ChatEntry) => void;
  readonly chatReceived: (event: RoomChatMessageEvent) => void;
  readonly chatSent: (
    clientMessageId: string,
    result: { messageId: string; sentAtMs: number },
  ) => void;
  readonly chatFailed: (clientMessageId: string, message: string) => void;
  readonly chatRetrying: (clientMessageId: string) => void;
  readonly memberRemoved: (reason: RoomMemberRemovedEvent['reason']) => void;
  readonly reset: () => void;
};

type PresenceOp =
  | { readonly kind: 'joined'; readonly user: PresenceUser }
  | { readonly kind: 'left'; readonly userId: UserId };

function applyPresenceOp(
  presence: readonly PresenceUser[],
  op: PresenceOp,
): readonly PresenceUser[] {
  if (op.kind === 'left') {
    return presence.filter((entry) => entry.userId !== op.userId);
  }
  return presence.some((entry) => entry.userId === op.user.userId)
    ? presence.map((entry) => (entry.userId === op.user.userId ? op.user : entry))
    : [...presence, op.user];
}

function capped(messages: readonly ChatEntry[]): readonly ChatEntry[] {
  return messages.length > MAX_CHAT_MESSAGES ? messages.slice(-MAX_CHAT_MESSAGES) : messages;
}

function withEntry(
  messages: readonly ChatEntry[],
  clientMessageId: string,
  change: (entry: ChatEntry) => ChatEntry,
): readonly ChatEntry[] {
  return messages.map((entry) =>
    entry.clientMessageId === clientMessageId ? change(entry) : entry,
  );
}

export function createRoomLiveStore(roomId: RoomId): StoreApi<RoomLiveState> {
  const initial = {
    joinStatus: 'idle',
    joinError: null,
    presence: [],
    messages: [],
    timer: null,
    removed: null,
  } as const;

  // Presence events applied between a join request and its answer. The answer's snapshot may
  // be older than them (events can be delivered before the ack), so they are replayed over it;
  // presence operations are idempotent by user id. `null` = no request outstanding.
  let sinceRequest: PresenceOp[] | null = null;
  // The same for timer events (F3): the newest one seen since the request is replayed over the
  // snapshot, which wins unless the event's version is greater.
  let timerSinceRequest: TimerView | null = null;

  return createStore<RoomLiveState>()((set) => ({
    roomId,
    ...initial,
    joining: () => {
      sinceRequest = [];
      timerSinceRequest = null;
      set((state) => (state.joinStatus === 'joined' ? state : { joinStatus: 'joining' }));
    },
    joined: (snapshot) => {
      // The snapshot is the authoritative picture at the moment of joining (M6); a repeated
      // join (reconnect, resync) replaces whatever the events had built up.
      const replay = sinceRequest ?? [];
      const bufferedTimer = timerSinceRequest;
      sinceRequest = null;
      timerSinceRequest = null;
      // The snapshot's timer replaces the held one whatever its version (RT2: after a Redis
      // loss a recreated timer's version is higher anyway); an event that arrived while the
      // request was out is replayed only if it is newer than the snapshot.
      const timer =
        bufferedTimer !== null &&
        bufferedTimer.roomId === roomId &&
        bufferedTimer.version > snapshot.timer.version
          ? bufferedTimer
          : snapshot.timer;
      set({
        joinStatus: 'joined',
        joinError: null,
        presence: replay.reduce(applyPresenceOp, snapshot.presence),
        timer,
        removed: null,
      });
    },
    joinFailed: (status, message) => {
      sinceRequest = null;
      timerSinceRequest = null;
      set({ joinStatus: status, joinError: message });
    },
    disconnected: () => {
      sinceRequest = null;
      timerSinceRequest = null;
      set((state) => (state.joinStatus === 'idle' ? state : { joinStatus: 'idle' }));
    },
    presenceJoined: (user) => {
      const op: PresenceOp = { kind: 'joined', user };
      sinceRequest?.push(op);
      set((state) => ({ presence: applyPresenceOp(state.presence, op) }));
    },
    presenceLeft: (userId) => {
      const op: PresenceOp = { kind: 'left', userId };
      sinceRequest?.push(op);
      set((state) => ({ presence: applyPresenceOp(state.presence, op) }));
    },
    timerReceived: (timer) => {
      if (timer.roomId !== roomId) {
        return;
      }
      if (
        sinceRequest !== null &&
        (timerSinceRequest === null || timer.version > timerSinceRequest.version)
      ) {
        timerSinceRequest = timer;
      }
      set((state) =>
        state.timer === null || timer.version > state.timer.version ? { timer } : state,
      );
    },
    chatPending: (entry) => {
      set((state) =>
        state.messages.some((known) => known.clientMessageId === entry.clientMessageId)
          ? state
          : { messages: capped([...state.messages, entry]) },
      );
    },
    chatReceived: (event) => {
      set((state) => {
        // The echo of this user's own message, or a repeat of one already shown: one entry.
        // Another sender reusing a client message id must never touch someone else's entry.
        const isOwnEcho = (entry: ChatEntry): boolean =>
          entry.clientMessageId === event.clientMessageId &&
          entry.sender.userId === event.sender.userId;
        if (state.messages.some(isOwnEcho)) {
          return {
            messages: state.messages.map((entry) =>
              isOwnEcho(entry)
                ? {
                    ...entry,
                    messageId: event.messageId,
                    sentAtMs: event.sentAtMs,
                    status: 'sent' as const,
                    error: null,
                  }
                : entry,
            ),
          };
        }
        if (state.messages.some((known) => known.messageId === event.messageId)) {
          return state;
        }
        // A colliding id from another sender gets a namespaced key so entries stay distinct.
        const collides = state.messages.some(
          (known) => known.clientMessageId === event.clientMessageId,
        );
        return {
          messages: capped([
            ...state.messages,
            {
              clientMessageId: collides
                ? `${event.sender.userId}:${event.clientMessageId}`
                : event.clientMessageId,
              messageId: event.messageId,
              sender: event.sender,
              body: event.body,
              sentAtMs: event.sentAtMs,
              status: 'sent',
              error: null,
            },
          ]),
        };
      });
    },
    chatSent: (clientMessageId, result) => {
      set((state) => ({
        messages: withEntry(state.messages, clientMessageId, (entry) => ({
          ...entry,
          messageId: result.messageId,
          sentAtMs: result.sentAtMs,
          status: 'sent',
          error: null,
        })),
      }));
    },
    chatFailed: (clientMessageId, message) => {
      set((state) => ({
        messages: withEntry(state.messages, clientMessageId, (entry) =>
          // The echo may already have arrived; a delivered message never turns into a failure.
          entry.status === 'sent' ? entry : { ...entry, status: 'failed', error: message },
        ),
      }));
    },
    chatRetrying: (clientMessageId) => {
      set((state) => ({
        messages: withEntry(state.messages, clientMessageId, (entry) =>
          entry.status === 'failed' ? { ...entry, status: 'pending', error: null } : entry,
        ),
      }));
    },
    memberRemoved: (reason) => {
      sinceRequest = null;
      timerSinceRequest = null;
      set({ removed: reason, joinStatus: 'idle', presence: [], messages: [], timer: null });
    },
    reset: () => {
      sinceRequest = null;
      timerSinceRequest = null;
      set({ ...initial });
    },
  }));
}

// ---- Registry: one store per room ------------------------------------------------------

const stores = new Map<RoomId, StoreApi<RoomLiveState>>();

export function getRoomLiveStore(roomId: RoomId): StoreApi<RoomLiveState> {
  let store = stores.get(roomId);
  if (store === undefined) {
    store = createRoomLiveStore(roomId);
    stores.set(roomId, store);
  }
  return store;
}

export function useRoomLive<T>(roomId: RoomId, selector: (state: RoomLiveState) => T): T {
  return useStore(getRoomLiveStore(roomId), selector);
}

// ---- Knocks, wherever the user is in the app ---------------------------------------------

export type OutgoingKnock =
  | { readonly status: 'waiting'; readonly expiresAtMs: number }
  | { readonly status: 'approved' | 'rejected' | 'expired' };

type KnockState = {
  /** Host side: pending knocks per room, in arrival order. */
  readonly incoming: Readonly<Record<string, readonly KnockView[]>>;
  /** Requester side: this user's own knocks and their outcome. */
  readonly outgoing: Readonly<Record<string, OutgoingKnock>>;
  readonly knockReceived: (roomId: RoomId, knock: KnockView) => void;
  readonly knockRemoved: (roomId: RoomId, userId: UserId) => void;
  /** The join snapshot's list is authoritative for its room. */
  readonly replaceIncoming: (roomId: RoomId, knocks: readonly KnockView[]) => void;
  readonly outgoingWaiting: (roomId: RoomId, expiresAtMs: number) => void;
  /** `expired` is not announced by the server: both sides know `expiresAtMs` (M7). */
  readonly outgoingResolved: (roomId: RoomId, outcome: 'approved' | 'rejected' | 'expired') => void;
  readonly clearOutgoing: (roomId: RoomId) => void;
  readonly reset: () => void;
};

const NO_KNOCKS: readonly KnockView[] = [];

export const useKnockStore = create<KnockState>()((set) => ({
  incoming: {},
  outgoing: {},
  knockReceived: (roomId, knock) => {
    set((state) => {
      const known = state.incoming[roomId] ?? NO_KNOCKS;
      // A repeated knock refreshes the entry (M7) and keeps its place.
      const next = known.some((entry) => entry.userId === knock.userId)
        ? known.map((entry) => (entry.userId === knock.userId ? knock : entry))
        : [...known, knock];
      return { incoming: { ...state.incoming, [roomId]: next } };
    });
  },
  knockRemoved: (roomId, userId) => {
    set((state) => {
      const known = state.incoming[roomId] ?? NO_KNOCKS;
      return known.some((entry) => entry.userId === userId)
        ? {
            incoming: {
              ...state.incoming,
              [roomId]: known.filter((entry) => entry.userId !== userId),
            },
          }
        : state;
    });
  },
  replaceIncoming: (roomId, knocks) => {
    set((state) => ({ incoming: { ...state.incoming, [roomId]: knocks } }));
  },
  outgoingWaiting: (roomId, expiresAtMs) => {
    set((state) => ({
      outgoing: { ...state.outgoing, [roomId]: { status: 'waiting', expiresAtMs } },
    }));
  },
  outgoingResolved: (roomId, outcome) => {
    set((state) => ({ outgoing: { ...state.outgoing, [roomId]: { status: outcome } } }));
  },
  clearOutgoing: (roomId) => {
    set((state) => ({
      outgoing: Object.fromEntries(Object.entries(state.outgoing).filter(([id]) => id !== roomId)),
    }));
  },
  reset: () => {
    set({ incoming: {}, outgoing: {} });
  },
}));

export const incomingKnocksFor = (roomId: RoomId) => (state: KnockState) =>
  state.incoming[roomId] ?? NO_KNOCKS;

/** Forgets all live room state: sign-out, or another user signing in. */
export function resetRoomLiveState(): void {
  // Stores stay registered (mounted components hold them); they are emptied in place.
  for (const store of stores.values()) {
    store.getState().reset();
  }
  useKnockStore.getState().reset();
}
