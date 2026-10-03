import {
  authSessionIdSchema,
  type ConnectErrorCode,
  type ConnectErrorData,
  handshakeAuthSchema,
  type SocketData,
  userIdSchema,
} from '@focus-flow/contracts';
import type { ExtendedError } from 'socket.io';

import { verifyAccessToken } from '../auth/jwt.js';
import { findUserById } from '../auth/queries.js';
import { type AuthDeps, checkAccessTokenRevoked } from '../auth/service.js';
import type { AppSocket } from './types.js';

export type HandshakeResult =
  | { readonly ok: true; readonly data: SocketData }
  | { readonly ok: false; readonly code: ConnectErrorCode };

/**
 * Socket authentication (docs/architecture/auth.md, "Socket authentication"). Exactly the
 * checks `requireAuth` runs for REST — the same JWT verification and the same revocation
 * check (a Redis marker, otherwise PostgreSQL) — plus "the user still exists". No new
 * identity mechanism: `socket.data` is derived only from the verified token.
 */
export const authenticateHandshake = async (
  deps: AuthDeps,
  auth: unknown,
): Promise<HandshakeResult> => {
  const parsed = handshakeAuthSchema.safeParse(auth);
  if (!parsed.success) {
    return { ok: false, code: 'UNAUTHENTICATED' };
  }

  const verified = await verifyAccessToken(parsed.data.token, {
    keys: deps.jwtKeys,
    issuer: deps.jwtIssuer,
    audience: deps.jwtAudience,
  });
  if (verified === undefined) {
    return { ok: false, code: 'UNAUTHENTICATED' };
  }

  // Throws a 503 when PostgreSQL is needed for the decision and is down: the client must
  // retry later, not treat its session as over.
  if (await checkAccessTokenRevoked(deps, verified.sid)) {
    return { ok: false, code: 'SESSION_REVOKED' };
  }

  const user = await findUserById(deps.db, verified.userId);
  if (user === undefined) {
    return { ok: false, code: 'UNAUTHENTICATED' };
  }

  return {
    ok: true,
    data: {
      userId: userIdSchema.parse(user.id),
      sid: authSessionIdSchema.parse(verified.sid),
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      tokenExpiresAtMs: verified.expiresAtMs,
      joinedRooms: [],
    },
  };
};

/** The refusal the client receives as `connect_error`: message and `data.code` agree. */
export const refuseConnection = (code: ConnectErrorCode): ExtendedError => {
  const data: ConnectErrorData = { code };
  return Object.assign(new Error(code), { data });
};

export const createHandshakeMiddleware =
  (deps: AuthDeps) =>
  (socket: AppSocket, next: (error?: ExtendedError) => void): void => {
    authenticateHandshake(deps, socket.handshake.auth).then(
      (result) => {
        if (result.ok) {
          socket.data = result.data;
          next();
        } else {
          next(refuseConnection(result.code));
        }
      },
      (error: unknown) => {
        // Never log the handshake `auth` object: it holds the access token.
        deps.logger.warn({ err: error }, 'Socket handshake failed');
        next(refuseConnection('INTERNAL'));
      },
    );
  };
