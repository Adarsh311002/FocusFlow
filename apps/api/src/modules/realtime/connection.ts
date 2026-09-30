import { type Ack, timeSyncRequestSchema, type TimeSyncResult } from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { redisTimeMs } from '../../platform/redis.js';
import { type AppSocket, sessionRoom, userRoom } from './types.js';

export type ConnectionDeps = {
  readonly redis: Redis;
  readonly logger: Logger;
  /** Hooks run for every authenticated socket (presence registers here). */
  readonly onConnect: readonly ((socket: AppSocket) => void)[];
};

const isFunction = (value: unknown): value is (...args: unknown[]) => void =>
  typeof value === 'function';

/**
 * `time:sync` (docs/api/socket-events.md): answers with Redis TIME, the authoritative
 * clock (approved), so clients measure their offset against the same clock the server
 * uses for protocol arithmetic.
 */
export const handleTimeSync = async (
  redis: Pick<Redis, 'time'>,
  request: unknown,
  ack: unknown,
): Promise<void> => {
  // A client that sends no acknowledgement callback gets nothing; there is nothing to do.
  if (!isFunction(ack)) {
    return;
  }
  const respond = (response: Ack<TimeSyncResult>): void => {
    ack(response);
  };

  if (!timeSyncRequestSchema.safeParse(request).success) {
    respond({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Invalid time:sync payload.' },
    });
    return;
  }
  try {
    respond({ ok: true, serverNowMs: await redisTimeMs(redis) });
  } catch {
    respond({
      ok: false,
      error: { code: 'INTERNAL', message: 'The server clock is unavailable.' },
    });
  }
};

/**
 * Runs for every socket that passed the handshake:
 * - joins the server-derived rooms `user:{userId}` and `session:{sid}`;
 * - disconnects the socket when its access token expires (the client reconnects with a
 *   fresh token; docs/architecture/auth.md). The API's own clock is fine here: the token's
 *   `exp` was set by the same API cluster, and this is not protocol arithmetic;
 * - registers the client event handlers.
 */
export const handleConnection = (socket: AppSocket, deps: ConnectionDeps): void => {
  const { userId, sid, tokenExpiresAtMs } = socket.data;

  void socket.join([userRoom(userId), sessionRoom(sid)]);

  const expiry = setTimeout(
    () => {
      socket.disconnect(true);
    },
    Math.max(0, tokenExpiresAtMs - Date.now()),
  );
  expiry.unref();
  socket.on('disconnect', () => {
    clearTimeout(expiry);
  });

  socket.on('time:sync', (request, ack) => {
    void handleTimeSync(deps.redis, request, ack);
  });

  for (const hook of deps.onConnect) {
    hook(socket);
  }
};
