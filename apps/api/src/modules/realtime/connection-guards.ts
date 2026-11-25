import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ExtendedError } from 'socket.io';

import { redisKeys } from '../../platform/redis-keys.js';
import { type RateLimiter, SOCKET_CONNECT_RATE } from '../room-realtime/limiter.js';
import { refuseConnection } from './handshake.js';
import type { AppSocket } from './types.js';

// Socket abuse protection (Phase 9, S1–S3). Two handshake guards around the token check:
//  - S1 before it: at most SOCKET_CONNECT_RATE connection attempts per client address, so a
//    flood is refused before any token is verified or PostgreSQL is asked. Fails OPEN (logged)
//    when Redis cannot count, like the broad HTTP limit: a Redis blip must not lock everyone
//    out, and every connection still has to pass the token check.
//  - S2 after it: at most `maxSocketsPerUser` live sockets per user (R4), counted from the
//    user's presence entries. The count is approximate on purpose: entries of a dead
//    instance linger until the reconciler removes them, and two simultaneous handshakes may
//    both pass. It bounds abuse; it is not an exact quota. Fails OPEN for the same reason.
// A refusal is a `connect_error` with `data.code` RATE_LIMITED or TOO_MANY_CONNECTIONS; the
// web client treats both like a temporary problem and retries with backoff.

export type ConnectionGuardDeps = {
  readonly limiter: RateLimiter;
  readonly redis: Redis;
  readonly logger: Logger;
  /** S1 is skipped when off (tests and the e2e stack, like HTTP_RATE_LIMIT). */
  readonly rateLimitEnabled: boolean;
  readonly maxSocketsPerUser: number;
  /** Behind one reverse proxy (production): the client is the last X-Forwarded-For entry. */
  readonly behindProxy: boolean;
};

type Next = (error?: ExtendedError) => void;

/** The address that connected, read the same way Express reads it with `trust proxy` 1. */
export const clientAddressOf = (
  handshake: { readonly address: string; readonly headers: Record<string, unknown> },
  behindProxy: boolean,
): string => {
  const forwarded = handshake.headers['x-forwarded-for'];
  if (behindProxy && typeof forwarded === 'string' && forwarded.trim() !== '') {
    const hops = forwarded.split(',').map((hop) => hop.trim());
    const last = hops[hops.length - 1];
    if (last !== undefined && last !== '') {
      return last;
    }
  }
  return handshake.address;
};

/** S1: runs before the token check. */
export const createConnectRateGuard =
  (deps: ConnectionGuardDeps) =>
  (socket: AppSocket, next: Next): void => {
    if (!deps.rateLimitEnabled) {
      next();
      return;
    }
    const address = clientAddressOf(socket.handshake, deps.behindProxy);
    deps.limiter.consume(SOCKET_CONNECT_RATE, address).then(
      (allowed) => {
        next(allowed ? undefined : refuseConnection('RATE_LIMITED'));
      },
      (error: unknown) => {
        deps.logger.warn({ err: error }, 'Socket connect rate unavailable; allowing');
        next();
      },
    );
  };

/** S2: runs after the token check, so `socket.data.userId` is the verified user. */
export const createSocketCapGuard =
  (deps: ConnectionGuardDeps) =>
  (socket: AppSocket, next: Next): void => {
    deps.redis.scard(redisKeys.userSockets(socket.data.userId)).then(
      (count) => {
        next(
          count >= deps.maxSocketsPerUser ? refuseConnection('TOO_MANY_CONNECTIONS') : undefined,
        );
      },
      (error: unknown) => {
        deps.logger.warn({ err: error }, 'Socket count unavailable; allowing');
        next();
      },
    );
  };
