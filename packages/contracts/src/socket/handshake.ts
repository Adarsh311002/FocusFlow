import { z } from 'zod';

/**
 * What the client sends in the Socket.IO handshake (`io({ auth })`): the same access
 * token REST uses in `Authorization: Bearer`. It travels in the handshake body, never in
 * the URL (docs/architecture/auth.md). Strict, so nothing identity-like can ride along.
 */
export const handshakeAuthSchema = z.strictObject({
  token: z.string().min(1),
});
export type HandshakeAuth = z.infer<typeof handshakeAuthSchema>;

/**
 * Why a handshake was refused, carried in the Socket.IO `connect_error` (`err.data`). The
 * client acts on the code:
 * - `UNAUTHENTICATED`: missing, invalid or expired token → refresh once, reconnect.
 * - `SESSION_REVOKED`: the session is over → the normal session-ended path.
 * - `INTERNAL`: a temporary server problem (for example the revocation check could not be
 *   completed) → retry later; the session is not ended.
 */
export const connectErrorCodeSchema = z.enum(['UNAUTHENTICATED', 'SESSION_REVOKED', 'INTERNAL']);
export type ConnectErrorCode = z.infer<typeof connectErrorCodeSchema>;

export const connectErrorDataSchema = z.object({ code: connectErrorCodeSchema });
export type ConnectErrorData = z.infer<typeof connectErrorDataSchema>;
