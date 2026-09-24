import type { Request } from 'express';

export type AuthenticatedUser = {
  readonly userId: string;
  readonly sid: string;
};

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth() (modules/auth/middleware.ts) after verifying the access token. */
      authUser?: AuthenticatedUser;
    }
  }
}

/**
 * Reads the user set by requireAuth(). Throws (→ a 500, not a 401) if called on a
 * route that isn't behind requireAuth() — that is a programming error, not an
 * unauthenticated request, which requireAuth() itself already rejected.
 */
export const getAuthUser = (req: Request): AuthenticatedUser => {
  if (req.authUser === undefined) {
    throw new Error('getAuthUser() called on a route without requireAuth() middleware');
  }
  return req.authUser;
};
