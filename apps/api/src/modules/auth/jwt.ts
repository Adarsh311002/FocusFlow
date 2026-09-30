import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';

import type { JwtSigningKey } from '../../platform/config.js';

const encoder = new TextEncoder();

export type AccessTokenClaims = {
  readonly userId: string;
  readonly sid: string;
};

export type JwtOptions = {
  readonly keys: readonly JwtSigningKey[];
  readonly issuer: string;
  readonly audience: string;
};

export type IssuedAccessToken = {
  readonly token: string;
  readonly expiresAt: Date;
};

/** The first configured key is always the active signer (docs/architecture/auth.md). */
export const issueAccessToken = async (
  claims: AccessTokenClaims,
  { keys, issuer, audience }: JwtOptions,
  ttlSeconds: number,
): Promise<IssuedAccessToken> => {
  const activeKey = keys[0];
  if (activeKey === undefined) {
    throw new Error('No JWT signing key configured');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;

  const token = await new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', kid: activeKey.kid })
    .setSubject(claims.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(encoder.encode(activeKey.secret));

  return { token, expiresAt: new Date(expiresAt * 1000) };
};

export type VerifiedAccessToken = {
  readonly userId: string;
  readonly sid: string;
};

/**
 * `undefined` for any failure (unknown key id, bad signature, expired, wrong
 * issuer/audience, malformed token) — the caller always treats verification
 * failure as "not authenticated", so no error detail needs to escape this
 * function.
 */
export const verifyAccessToken = async (
  token: string,
  { keys, issuer, audience }: JwtOptions,
): Promise<VerifiedAccessToken | undefined> => {
  let kid: string | undefined;
  try {
    ({ kid } = decodeProtectedHeader(token));
  } catch {
    return undefined;
  }

  const key = keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) {
    return undefined;
  }

  try {
    const { payload } = await jwtVerify(token, encoder.encode(key.secret), {
      issuer,
      audience,
      algorithms: ['HS256'],
    });

    const userId = payload.sub;
    const sid = payload.sid;
    if (typeof userId !== 'string' || typeof sid !== 'string') {
      return undefined;
    }
    return { userId, sid };
  } catch {
    return undefined;
  }
};
