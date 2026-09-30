import type { RequestHandler } from 'express';

import { AppError } from '../../platform/http/errors.js';
import { verifyAccessToken } from './jwt.js';
import { type AuthDeps, checkAccessTokenRevoked } from './service.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Identity for every protected route comes only from here: a verified JWT signature
 * plus a live revocation check, never from anything the client supplies in a body or
 * query (F7-equivalent for REST). On success sets `req.authUser`; on any failure
 * calls `next(AppError)` and never proceeds to the route handler.
 */
export const requireAuth = (deps: AuthDeps): RequestHandler => {
  return (req, _res, next) => {
    void (async () => {
      const header = req.headers.authorization;
      const token =
        typeof header === 'string' && header.startsWith(BEARER_PREFIX)
          ? header.slice(BEARER_PREFIX.length)
          : undefined;

      if (token === undefined) {
        next(new AppError('UNAUTHENTICATED', 401, 'Authentication required.'));
        return;
      }

      const verified = await verifyAccessToken(token, {
        keys: deps.jwtKeys,
        issuer: deps.jwtIssuer,
        audience: deps.jwtAudience,
      });
      if (verified === undefined) {
        next(new AppError('UNAUTHENTICATED', 401, 'Authentication required.'));
        return;
      }

      if (await checkAccessTokenRevoked(deps, verified.sid)) {
        next(new AppError('SESSION_REVOKED', 401, 'This session has been revoked.'));
        return;
      }

      req.authUser = { userId: verified.userId, sid: verified.sid };
      next();
    })().catch(next);
  };
};
