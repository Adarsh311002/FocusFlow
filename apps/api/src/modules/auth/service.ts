import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg-errors.js';
import type { JwtSigningKey } from '../../platform/config.js';
import { AppError } from '../../platform/http/errors.js';
import { issueAccessToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  type AuthSessionRow,
  findAuthSessionById,
  findUserByEmail,
  insertAuthSession,
  insertUser,
  revokeAuthSession,
  rotateAuthSession,
  touchAuthSessionLastUsed,
  type UserRow,
} from './queries.js';
import { decideRefresh } from './refresh-decision.js';
import {
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  parseRefreshToken,
} from './refresh-token.js';
import { isSessionRevoked, markSessionRevoked } from './revocation.js';

export type AuthDeps = {
  readonly db: Db;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly jwtKeys: readonly JwtSigningKey[];
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly refreshOverlapSeconds: number;
};

const jwtOptions = (deps: AuthDeps) => ({
  keys: deps.jwtKeys,
  issuer: deps.jwtIssuer,
  audience: deps.jwtAudience,
});

export type IssuedTokens = {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
};

const issueSessionAndTokens = async (
  deps: AuthDeps,
  executor: Executor,
  userId: string,
): Promise<IssuedTokens> => {
  const sid = uuidv7();
  const secret = generateRefreshSecret();
  const expiresAt = new Date(Date.now() + deps.refreshTokenTtlSeconds * 1_000);

  await insertAuthSession(executor, {
    id: sid,
    userId,
    currentTokenHash: hashRefreshSecret(secret),
    expiresAt,
  });

  const { token: accessToken, expiresAt: accessTokenExpiresAt } = await issueAccessToken(
    { userId, sid },
    jwtOptions(deps),
    deps.accessTokenTtlSeconds,
  );

  return { accessToken, accessTokenExpiresAt, refreshToken: formatRefreshToken(sid, secret) };
};

export type AuthResult = IssuedTokens & { readonly user: UserRow };

export const signup = async (
  deps: AuthDeps,
  input: { email: string; password: string; displayName: string },
): Promise<AuthResult> => {
  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);

  try {
    // Both writes commit together: if the session insert ever failed after the user
    // insert succeeded, an un-transacted signup would leave an orphaned user with no
    // way to sign in (a retry would just get EMAIL_TAKEN). The rollback makes that
    // failure mode impossible.
    return await deps.db.transaction(async (tx) => {
      const user = await insertUser(tx, {
        id: uuidv7(),
        email,
        displayName: input.displayName,
        passwordHash,
        emailVerifiedAt: null,
      });

      const tokens = await issueSessionAndTokens(deps, tx, user.id);
      return { user, ...tokens };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Deliberately vague: whether the existing account is password- or Google-only
      // is not revealed (docs/architecture/auth.md).
      throw new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists.');
    }
    throw error;
  }
};

// A real argon2id hash of a fixed, never-used password. Verifying against it when no
// real user/password exists keeps an unknown-email login roughly as slow as a
// wrong-password login, so response timing cannot be used to enumerate accounts.
const DUMMY_PASSWORD_HASH_INPUT = 'focus-flow-timing-normalization-only-never-a-real-account';
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => {
  dummyHash ??= hashPassword(DUMMY_PASSWORD_HASH_INPUT);
  return dummyHash;
};

export const login = async (
  deps: AuthDeps,
  input: { email: string; password: string },
): Promise<AuthResult> => {
  const email = input.email.toLowerCase();
  const user = await findUserByEmail(deps.db, email);

  const hashToCheck = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(hashToCheck, input.password);

  // Every failure path (unknown email, Google-only account, wrong password) returns
  // the same error (docs/architecture/auth.md).
  if (user === undefined || user.passwordHash === null || !passwordOk) {
    throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password.');
  }

  const tokens = await issueSessionAndTokens(deps, deps.db, user.id);
  return { user, ...tokens };
};

export type RefreshResult =
  | {
      readonly kind: 'ok';
      readonly accessToken: string;
      readonly accessTokenExpiresAt: Date;
      readonly newRefreshToken?: string;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'revoked' };

const MAX_ROTATION_ATTEMPTS = 3;

const revokeAndMark = async (deps: AuthDeps, sid: string): Promise<void> => {
  await revokeAuthSession(deps.db, sid);
  await markSessionRevoked(deps.redis, sid, deps.accessTokenTtlSeconds, deps.logger);
};

/**
 * Implements the full refresh state machine (docs/architecture/auth.md), including
 * safe concurrent rotation: `rotateAuthSession` is an atomic compare-and-swap
 * (modules/auth/queries.ts). When two requests race with the same starting token,
 * exactly one wins the UPDATE; the other re-reads the row (now updated by the
 * winner) and re-decides — which resolves to 'overlap', not 'reuse', because the
 * winner's rotation moved the loser's presented hash into `previous_token_hash`.
 */
export const refresh = async (
  deps: AuthDeps,
  cookieValue: string | undefined,
): Promise<RefreshResult> => {
  if (cookieValue === undefined) {
    return { kind: 'invalid' };
  }

  const parsed = parseRefreshToken(cookieValue);
  if (parsed === undefined) {
    return { kind: 'invalid' };
  }

  const presentedHash = hashRefreshSecret(parsed.secret);
  let session: AuthSessionRow | undefined = await findAuthSessionById(deps.db, parsed.sid);

  for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt += 1) {
    if (session === undefined) {
      return { kind: 'invalid' };
    }
    const currentSession = session;

    const decision = decideRefresh(currentSession, presentedHash, new Date());

    if (decision.kind === 'invalid') {
      return { kind: 'invalid' };
    }

    if (decision.kind === 'reuse') {
      deps.logger.warn({ sid: parsed.sid }, 'Refresh token reuse detected; revoking session');
      await revokeAndMark(deps, parsed.sid);
      return { kind: 'revoked' };
    }

    if (decision.kind === 'overlap') {
      await touchAuthSessionLastUsed(deps.db, parsed.sid);
      const { token, expiresAt } = await issueAccessToken(
        { userId: currentSession.userId, sid: parsed.sid },
        jwtOptions(deps),
        deps.accessTokenTtlSeconds,
      );
      return { kind: 'ok', accessToken: token, accessTokenExpiresAt: expiresAt };
    }

    // decision.kind === 'rotate'
    const newSecret = generateRefreshSecret();
    const rotated = await rotateAuthSession(
      deps.db,
      parsed.sid,
      presentedHash,
      hashRefreshSecret(newSecret),
      new Date(Date.now() + deps.refreshOverlapSeconds * 1_000),
    );

    if (rotated !== undefined) {
      const { token, expiresAt } = await issueAccessToken(
        { userId: rotated.userId, sid: parsed.sid },
        jwtOptions(deps),
        deps.accessTokenTtlSeconds,
      );
      return {
        kind: 'ok',
        accessToken: token,
        accessTokenExpiresAt: expiresAt,
        newRefreshToken: formatRefreshToken(parsed.sid, newSecret),
      };
    }

    // Lost the race: re-read and let the next iteration re-decide against the row a
    // concurrent request just changed.
    session = await findAuthSessionById(deps.db, parsed.sid);
  }

  deps.logger.error({ sid: parsed.sid }, 'Refresh rotation retries exhausted under contention');
  return { kind: 'invalid' };
};

/**
 * Uses the same decision engine as refresh(): revokes only if the presented token
 * actually proves ownership of the session (matches the current or still-valid
 * previous hash). A stale/wrong token against a real session is treated the same
 * defensive way refresh() treats reuse. Always succeeds from the caller's point of
 * view — there is nothing further to do once the session is gone either way.
 */
export const logout = async (deps: AuthDeps, cookieValue: string | undefined): Promise<void> => {
  if (cookieValue === undefined) {
    return;
  }
  const parsed = parseRefreshToken(cookieValue);
  if (parsed === undefined) {
    return;
  }

  const session = await findAuthSessionById(deps.db, parsed.sid);
  const decision = decideRefresh(session, hashRefreshSecret(parsed.secret), new Date());

  if (decision.kind === 'invalid') {
    return;
  }

  await revokeAndMark(deps, parsed.sid);
};

export const checkAccessTokenRevoked = (deps: AuthDeps, sid: string): Promise<boolean> =>
  isSessionRevoked(deps.redis, deps.db, sid, deps.logger);
