import { API_BASE_PATH, CLIENT_HEADER_NAME } from '@focus-flow/contracts';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';

// docs/architecture/auth.md: HttpOnly; Secure; SameSite=Strict; scoped to the auth
// routes only, so the browser never attaches it to an unrelated request. `Secure`
// cookies work on http://localhost/127.0.0.1 without TLS (browsers treat both as
// trustworthy), so there is no environment-dependent branch here.
export const REFRESH_COOKIE_NAME = 'ff_refresh_token';
// Derived from API_BASE_PATH (not hand-copied) so this can never drift from where
// createAuthRouter is actually mounted (platform/http/app.ts).
const REFRESH_COOKIE_PATH = `${API_BASE_PATH}/auth`;

export { CLIENT_HEADER_NAME };

export const setRefreshCookie = (res: Response, token: string, maxAgeSeconds: number): void => {
  res.appendHeader(
    'Set-Cookie',
    stringifySetCookie({
      name: REFRESH_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: maxAgeSeconds,
    }),
  );
};

export const clearRefreshCookie = (res: Response): void => {
  res.appendHeader(
    'Set-Cookie',
    stringifySetCookie({
      name: REFRESH_COOKIE_NAME,
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: 0,
    }),
  );
};

export const readRefreshCookie = (req: Request): string | undefined => {
  const header = req.headers.cookie;
  if (typeof header !== 'string') {
    return undefined;
  }
  return parseCookie(header)[REFRESH_COOKIE_NAME];
};

export const hasClientHeader = (req: Request): boolean => {
  const value = req.headers[CLIENT_HEADER_NAME];
  return typeof value === 'string' && value.length > 0;
};
