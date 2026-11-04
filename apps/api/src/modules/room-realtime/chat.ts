import type { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';

import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';

// Chat de-duplication (M8, D7): chat is never stored, so the only state is a 60 s marker
// per `(userId, roomId, clientMessageId)` holding the ids of the message that was delivered. A
// retry of the same message (a lost acknowledgement) is answered with those ids and is not
// delivered again.

export const CHAT_DEDUPE_TTL_MS = 60_000;

export type ChatMessageIds = { readonly messageId: string; readonly sentAtMs: number };

/** `{messageId}:{sentAtMs}` as stored; `undefined` for anything else. */
export const parseDedupeValue = (value: string | null): ChatMessageIds | undefined => {
  if (value === null) {
    return undefined;
  }
  const separator = value.lastIndexOf(':');
  if (separator <= 0) {
    return undefined;
  }
  const sentAtMs = Number(value.slice(separator + 1));
  return Number.isInteger(sentAtMs) && sentAtMs >= 0
    ? { messageId: value.slice(0, separator), sentAtMs }
    : undefined;
};

export type ChatDedupe = {
  /** The ids of an already delivered message with this client id, if any. */
  readonly find: (
    userId: string,
    roomId: string,
    clientMessageId: string,
  ) => Promise<ChatMessageIds | undefined>;
  /**
   * Claims the client id for a new message (UUIDv7, Redis TIME). `duplicate` is the
   * winner's ids when another request claimed it first.
   */
  readonly claim: (
    userId: string,
    roomId: string,
    clientMessageId: string,
  ) => Promise<
    | { readonly claimed: true; readonly ids: ChatMessageIds }
    | { readonly claimed: false; readonly duplicate: ChatMessageIds }
  >;
};

export const createChatDedupe = (redis: Redis): ChatDedupe => {
  const find: ChatDedupe['find'] = async (userId, roomId, clientMessageId) =>
    parseDedupeValue(await redis.get(redisKeys.chatDedupe(userId, roomId, clientMessageId)));

  return {
    find,
    claim: async (userId, roomId, clientMessageId) => {
      const ids = { messageId: uuidv7(), sentAtMs: await redisTimeMs(redis) };
      const stored = await redis.set(
        redisKeys.chatDedupe(userId, roomId, clientMessageId),
        `${ids.messageId}:${String(ids.sentAtMs)}`,
        'PX',
        CHAT_DEDUPE_TTL_MS,
        'NX',
      );
      if (stored === 'OK') {
        return { claimed: true, ids };
      }
      const duplicate = await find(userId, roomId, clientMessageId);
      // The marker expired between the two commands: this request is the first of its
      // 60-second window after all, but its ids are not stored. Treat it as new.
      return duplicate === undefined ? { claimed: true, ids } : { claimed: false, duplicate };
    },
  };
};
