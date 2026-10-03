import {
  API_BASE_PATH,
  authPaths,
  authResponseSchema,
  errorBodySchema,
  mePaths,
  refreshResponseSchema,
} from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { authIdentities, authSessions, users } from '../../db/schema.js';
import { CLIENT_HEADER_NAME, REFRESH_COOKIE_NAME } from './cookies.js';
import { parseRefreshToken } from './refresh-token.js';

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const url = (path: string): string => `${requireHarness().baseUrl}${API_BASE_PATH}${path}`;

const findCookie = (headers: Headers, name: string): string | undefined => {
  return headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
};

const cookieValue = (setCookieEntry: string): string => {
  const [pair] = setCookieEntry.split(';');
  const eq = (pair ?? '').indexOf('=');
  return (pair ?? '').slice(eq + 1);
};

type Signup = { email: string; password: string; displayName: string };

const newSignup = (label: string): Signup => ({
  email: `${label}-${Math.random().toString(36).slice(2)}@example.com`,
  password: 'a-long-enough-password',
  displayName: 'Test User',
});

const signup = async (
  body: Signup,
): Promise<{ response: Response; refreshCookie: string | undefined }> => {
  const response = await fetch(url(authPaths.signup), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = findCookie(response.headers, REFRESH_COOKIE_NAME);
  return { response, refreshCookie: raw === undefined ? undefined : cookieValue(raw) };
};

const authedFetch = (path: string, refresh: string): Promise<Response> => {
  return fetch(url(path), {
    method: 'POST',
    headers: {
      [CLIENT_HEADER_NAME]: '1',
      Cookie: `${REFRESH_COOKIE_NAME}=${refresh}`,
    },
  });
};

beforeAll(async () => {
  harness = await startTestHarness();
}, 120_000);

afterAll(async () => {
  if (harness === undefined) {
    return;
  }
  await stopTestHarness(harness);
}, 60_000);

// Every test starts from an empty account/session table and an empty revocation cache,
// so tests never interfere with each other regardless of execution order.
beforeEach(async () => {
  const { db, redis } = requireHarness();
  await db.delete(authIdentities);
  await db.delete(authSessions);
  await db.delete(users);
  await redis.flushdb();
});

describe('signup', () => {
  it('creates an account and returns a session', async () => {
    const body = newSignup('signup');
    const { response, refreshCookie } = await signup(body);

    expect(response.status).toBe(201);
    const parsed = authResponseSchema.parse(await response.json());
    expect(parsed.user.email).toBe(body.email.toLowerCase());
    expect(parsed.user.emailVerified).toBe(false);
    expect(parsed.user.identities).toEqual([]);
    expect(refreshCookie).toBeDefined();
  });

  it('sets the refresh cookie with the required attributes', async () => {
    const { response } = await signup(newSignup('cookie-attrs'));
    const raw = findCookie(response.headers, REFRESH_COOKIE_NAME);

    expect(raw).toBeDefined();
    const attrs = (raw ?? '').toLowerCase();
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('secure');
    expect(attrs).toContain('samesite=strict');
    expect(attrs).toContain('path=/api/v1/auth');
  });

  describe('duplicate signup', () => {
    it('rejects a second signup with the same email', async () => {
      const body = newSignup('dup');
      const first = await signup(body);
      expect(first.response.status).toBe(201);

      const second = await signup(body);
      expect(second.response.status).toBe(409);
      expect(errorBodySchema.parse(await second.response.json()).error.code).toBe('EMAIL_TAKEN');
    });

    it('lets only one signup win when two identical signups race concurrently', async () => {
      const body = newSignup('race');

      const [a, b] = await Promise.all([signup(body), signup(body)]);
      const statuses = [a.response.status, b.response.status].sort();

      // Exactly one succeeds; the other is rejected as a duplicate — never both
      // succeeding, and never a generic 500 from an unhandled constraint violation.
      expect(statuses).toEqual([201, 409]);
    });
  });

  it('rejects a password shorter than 8 characters before touching the database', async () => {
    const response = await fetch(url(authPaths.signup), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'short@example.com', password: 'short', displayName: 'X' }),
    });

    expect(response.status).toBe(400);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('logs in with the correct credentials', async () => {
    const body = newSignup('login');
    await signup(body);

    const response = await fetch(url(authPaths.login), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.email, password: body.password }),
    });

    expect(response.status).toBe(200);
    expect(authResponseSchema.parse(await response.json()).user.email).toBe(
      body.email.toLowerCase(),
    );
  });

  describe('invalid credentials', () => {
    it('rejects an unknown email with a generic error', async () => {
      const response = await fetch(url(authPaths.login), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nobody-here@example.com',
          password: 'a-long-enough-password',
        }),
      });

      expect(response.status).toBe(401);
      expect(errorBodySchema.parse(await response.json()).error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects the wrong password for a real account with the same generic error', async () => {
      const body = newSignup('wrongpw');
      await signup(body);

      const response = await fetch(url(authPaths.login), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: body.email, password: 'not-the-right-password' }),
      });

      expect(response.status).toBe(401);
      expect(errorBodySchema.parse(await response.json()).error.code).toBe('INVALID_CREDENTIALS');
    });

    it('is case-insensitive on email', async () => {
      const body = newSignup('caseinsensitive');
      await signup(body);

      const response = await fetch(url(authPaths.login), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: body.email.toUpperCase(), password: body.password }),
      });

      expect(response.status).toBe(200);
    });
  });
});

describe('GET /me', () => {
  it('rejects a request with no access token', async () => {
    const response = await fetch(url(mePaths.self));
    expect(response.status).toBe(401);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('UNAUTHENTICATED');
  });

  describe('invalid JWT', () => {
    it('rejects a structurally invalid bearer token', async () => {
      const response = await fetch(url(mePaths.self), {
        headers: { Authorization: 'Bearer not-a-real-jwt' },
      });
      expect(response.status).toBe(401);
      expect(errorBodySchema.parse(await response.json()).error.code).toBe('UNAUTHENTICATED');
    });
  });

  it('returns the signed-in user for a valid access token', async () => {
    const body = newSignup('me');
    const { response: signupResponse } = await signup(body);
    const { accessToken, user } = authResponseSchema.parse(await signupResponse.json());

    const response = await fetch(url(mePaths.self), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    const meBody: unknown = await response.json();
    expect((meBody as { user: { id: string } }).user.id).toBe(user.id);
  });

  it('returns 404 for a validly-signed token whose user no longer exists', async () => {
    // A valid JWT signature only proves the token was issued by this server, not that
    // its subject still exists (e.g. deleted between issuance and use); the route must
    // check that separately rather than trusting the token's claims as fact.
    const body = newSignup('deleted-user');
    const { response: signupResponse } = await signup(body);
    const { accessToken, user } = authResponseSchema.parse(await signupResponse.json());

    const { db } = requireHarness();
    await db.delete(users).where(eq(users.id, user.id));

    const response = await fetch(url(mePaths.self), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('NOT_FOUND');
  });

  describe('session isolation between users', () => {
    it("cannot see another user's data through their own valid token", async () => {
      const { response: aResponse } = await signup(newSignup('isolation-a'));
      const { response: bResponse } = await signup(newSignup('isolation-b'));
      const a = authResponseSchema.parse(await aResponse.json());
      const b = authResponseSchema.parse(await bResponse.json());

      const meAsA = await fetch(url(mePaths.self), {
        headers: { Authorization: `Bearer ${a.accessToken}` },
      });
      const bodyAsA: unknown = await meAsA.json();

      expect((bodyAsA as { user: { id: string } }).user.id).toBe(a.user.id);
      expect((bodyAsA as { user: { id: string } }).user.id).not.toBe(b.user.id);
    });
  });
});

describe('refresh', () => {
  it('rejects a refresh request with no client header', async () => {
    const { refreshCookie } = await signup(newSignup('noheader'));
    const response = await fetch(url(authPaths.refresh), {
      method: 'POST',
      headers: { Cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}` },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a refresh request with no cookie', async () => {
    const response = await fetch(url(authPaths.refresh), {
      method: 'POST',
      headers: { [CLIENT_HEADER_NAME]: '1' },
    });
    expect(response.status).toBe(401);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('SESSION_INVALID');
  });

  it('rotates the refresh token and issues a new access token', async () => {
    const { refreshCookie } = await signup(newSignup('rotate'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

    const response = await authedFetch(authPaths.refresh, refreshCookie);
    expect(response.status).toBe(200);
    refreshResponseSchema.parse(await response.json());

    const newCookieRaw = findCookie(response.headers, REFRESH_COOKIE_NAME);
    expect(newCookieRaw).toBeDefined();
    expect(cookieValue(newCookieRaw ?? '')).not.toBe(refreshCookie);
  });

  it('refresh issues a working access token a client can use to recover from a 401', async () => {
    // Real, time-based expiry is exercised at the unit level in jwt.test.ts ('rejects
    // an expired token'), where a negative TTL makes the assertion instant instead of
    // requiring this suite to wait out ACCESS_TOKEN_TTL_SECONDS's real 60-second floor.
    // This test proves the other half of the path a client actually takes: refresh,
    // then retry the original request with the newly issued access token.
    const { refreshCookie } = await signup(newSignup('recover'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

    const refreshed = await authedFetch(authPaths.refresh, refreshCookie);
    const { accessToken } = refreshResponseSchema.parse(await refreshed.json());

    const me = await fetch(url(mePaths.self), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(me.status).toBe(200);
  });

  it('rejects a refresh once the session has passed its expiresAt', async () => {
    // decideRefresh's expiry branch is already unit-tested against a plain snapshot
    // (refresh-decision.test.ts); this proves the same behavior end-to-end through the
    // real route and the real committed schema/column, not just the pure function.
    const { refreshCookie } = await signup(newSignup('session-expired'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');
    const parsed = parseRefreshToken(refreshCookie);
    if (parsed === undefined) throw new Error('expected a parseable refresh token');

    const { db } = requireHarness();
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(authSessions.id, parsed.sid));

    const response = await authedFetch(authPaths.refresh, refreshCookie);
    expect(response.status).toBe(401);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('SESSION_INVALID');
  });

  describe('previous-token overlap semantics', () => {
    it('accepts the immediately-previous refresh token again within the overlap window', async () => {
      const { refreshCookie } = await signup(newSignup('overlap'));
      if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

      // Rotate once.
      const first = await authedFetch(authPaths.refresh, refreshCookie);
      expect(first.status).toBe(200);

      // Present the ORIGINAL (now "previous") token again — simulating a second tab
      // that read the cookie before the first tab's rotation landed.
      const second = await authedFetch(authPaths.refresh, refreshCookie);
      expect(second.status).toBe(200);
      // Overlap issues an access token only — no new cookie is set.
      expect(findCookie(second.headers, REFRESH_COOKIE_NAME)).toBeUndefined();
    });
  });

  describe('two simultaneous refresh requests', () => {
    it('both succeed, but only the race winner rotates the cookie — the loser gets overlap', async () => {
      const { refreshCookie } = await signup(newSignup('concurrent'));
      if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

      const [a, b] = await Promise.all([
        authedFetch(authPaths.refresh, refreshCookie),
        authedFetch(authPaths.refresh, refreshCookie),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Both get a usable access token, but rotateAuthSession's compare-and-swap
      // (queries.ts) lets only one request actually win the rotation; the other must
      // fall through to the overlap path (decideRefresh), not also rotate — otherwise
      // two live refresh tokens would exist for the same session simultaneously.
      const aCookie = findCookie(a.headers, REFRESH_COOKIE_NAME);
      const bCookie = findCookie(b.headers, REFRESH_COOKIE_NAME);
      const newCookieCount = [aCookie, bCookie].filter((cookie) => cookie !== undefined).length;
      expect(newCookieCount).toBe(1);
    });
  });

  describe('old refresh token replay (reuse)', () => {
    it('revokes the session when a token from two rotations ago is replayed', async () => {
      const { refreshCookie: original } = await signup(newSignup('replay'));
      if (original === undefined) throw new Error('expected a refresh cookie');

      const firstRotation = await authedFetch(authPaths.refresh, original);
      const firstNewCookie = cookieValue(
        findCookie(firstRotation.headers, REFRESH_COOKIE_NAME) ?? '',
      );

      const secondRotation = await authedFetch(authPaths.refresh, firstNewCookie);
      expect(secondRotation.status).toBe(200);

      // Replay the very first token, which is now two rotations stale.
      const replay = await authedFetch(authPaths.refresh, original);
      expect(replay.status).toBe(401);
      expect(errorBodySchema.parse(await replay.json()).error.code).toBe('SESSION_REVOKED');
    });

    it('revoked session: the access token issued before revocation stops working immediately', async () => {
      const { response: signupResponse, refreshCookie: original } = await signup(
        newSignup('revoked-fast'),
      );
      if (original === undefined) throw new Error('expected a refresh cookie');
      const { accessToken } = authResponseSchema.parse(await signupResponse.json());

      // A single rotation puts `original` in the overlap window, where replaying it is
      // legitimate (D23) — not reuse. Genuine revocation requires the token to be from
      // *two* rotations ago, exactly like the sibling test above.
      const firstRotation = await authedFetch(authPaths.refresh, original);
      const firstNewCookie = cookieValue(
        findCookie(firstRotation.headers, REFRESH_COOKIE_NAME) ?? '',
      );
      const secondRotation = await authedFetch(authPaths.refresh, firstNewCookie);
      expect(secondRotation.status).toBe(200);

      // Replay the very first token, which is now two rotations stale.
      const replay = await authedFetch(authPaths.refresh, original);
      expect(replay.status).toBe(401);
      expect(errorBodySchema.parse(await replay.json()).error.code).toBe('SESSION_REVOKED');

      // The access token from signup has not expired, but its session is revoked —
      // this must be rejected immediately (Redis marker, or PostgreSQL without it), not
      // after 15 minutes.
      const me = await fetch(url(mePaths.self), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(me.status).toBe(401);
      expect(errorBodySchema.parse(await me.json()).error.code).toBe('SESSION_REVOKED');
    });
  });
});

describe('logout', () => {
  it('rejects a logout request with no client header', async () => {
    const { refreshCookie } = await signup(newSignup('logout-noheader'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

    const response = await fetch(url(authPaths.logout), {
      method: 'POST',
      headers: { Cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}` },
    });
    expect(response.status).toBe(401);

    // The session must still be usable: the missing-header request never reached the
    // point of revoking anything.
    const stillWorks = await authedFetch(authPaths.refresh, refreshCookie);
    expect(stillWorks.status).toBe(200);
  });

  it('revokes the session so the refresh token no longer works', async () => {
    const { refreshCookie } = await signup(newSignup('logout'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

    const logoutResponse = await authedFetch(authPaths.logout, refreshCookie);
    expect(logoutResponse.status).toBe(204);

    const afterLogout = await authedFetch(authPaths.refresh, refreshCookie);
    expect(afterLogout.status).toBe(401);
  });

  it('is safe to repeat', async () => {
    const { refreshCookie } = await signup(newSignup('logout-twice'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

    const first = await authedFetch(authPaths.logout, refreshCookie);
    const second = await authedFetch(authPaths.logout, refreshCookie);

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  describe('logout racing with refresh', () => {
    it('either order leaves the session unusable afterwards', async () => {
      const { refreshCookie } = await signup(newSignup('logout-race'));
      if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

      await Promise.all([
        authedFetch(authPaths.logout, refreshCookie),
        authedFetch(authPaths.refresh, refreshCookie),
      ]);

      // Whichever order the two requests actually executed in, the session must end
      // up revoked, not left in a valid state.
      const after = await authedFetch(authPaths.refresh, refreshCookie);
      expect(after.status).toBe(401);
    });
  });

  it('clears the refresh cookie', async () => {
    const { refreshCookie } = await signup(newSignup('logout-clears-cookie'));
    if (refreshCookie === undefined) throw new Error('expected a refresh cookie');

    const response = await authedFetch(authPaths.logout, refreshCookie);
    const cleared = findCookie(response.headers, REFRESH_COOKIE_NAME);

    expect(cleared).toBeDefined();
    expect(cookieValue(cleared ?? 'x=nonempty')).toBe('');
  });
});
