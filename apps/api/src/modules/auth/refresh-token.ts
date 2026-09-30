import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// docs/architecture/auth.md: the refresh token is "{sid}.{secret}". `sid` identifies
// the auth_sessions row (not secret — it is the row's own primary key); `secret` is a
// high-entropy random value compared only by hash. Unlike a password, a 256-bit
// random secret needs no slow hash (argon2/bcrypt exist to slow down guessing a
// low-entropy value); a fast SHA-256 digest is the standard choice here.
const SECRET_BYTES = 32;

export type ParsedRefreshToken = { readonly sid: string; readonly secret: string };

export const generateRefreshSecret = (): string => randomBytes(SECRET_BYTES).toString('base64url');

export const formatRefreshToken = (sid: string, secret: string): string => `${sid}.${secret}`;

// `sid` is always a UUID (it is the auth_sessions primary key); checking its shape
// here means a garbage cookie is rejected before it ever reaches a query, rather than
// reaching PostgreSQL and raising a driver-level "invalid input syntax for type uuid"
// error that would otherwise surface as an uncaught 500 on refresh/logout.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `undefined` for anything not shaped like "{sid}.{secret}" — never throws on bad input. */
export const parseRefreshToken = (token: string): ParsedRefreshToken | undefined => {
  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return undefined;
  }
  const sid = token.slice(0, separatorIndex);
  if (!UUID_PATTERN.test(sid)) {
    return undefined;
  }
  return { sid, secret: token.slice(separatorIndex + 1) };
};

export const hashRefreshSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

/**
 * Constant-time comparison of two hashes. Plain `===` can short-circuit on the
 * first differing byte; for a value that gates session access, that timing
 * difference is avoidable at negligible cost, so it is avoided.
 */
export const refreshHashesMatch = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
};
