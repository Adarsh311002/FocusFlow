import { authPaths, loginRequestSchema, signupRequestSchema } from '@focus-flow/contracts';
import { type Request, type Response, Router } from 'express';

import { AppError, parseRequestBody } from '../../platform/http/errors.js';
import { toUserView } from '../users/views.js';
import {
  clearRefreshCookie,
  CLIENT_HEADER_NAME,
  hasClientHeader,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies.js';
import { type AuthDeps, type AuthResult, login, logout, refresh, signup } from './service.js';

const sendAuthResult = async (
  deps: AuthDeps,
  res: Response,
  status: number,
  result: AuthResult,
): Promise<void> => {
  setRefreshCookie(res, result.refreshToken, deps.refreshTokenTtlSeconds);
  res.status(status).json({
    user: await toUserView(deps.db, result.user),
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
  });
};

const requireClientHeader = (req: Request): void => {
  if (!hasClientHeader(req)) {
    throw new AppError('UNAUTHENTICATED', 401, `Missing required "${CLIENT_HEADER_NAME}" header.`);
  }
};

export const createAuthRouter = (deps: AuthDeps): Router => {
  const router = Router();

  router.post(authPaths.signup, (req, res, next) => {
    void (async () => {
      const body = parseRequestBody(signupRequestSchema, req.body);
      const result = await signup(deps, body);
      await sendAuthResult(deps, res, 201, result);
    })().catch(next);
  });

  router.post(authPaths.login, (req, res, next) => {
    void (async () => {
      const body = parseRequestBody(loginRequestSchema, req.body);
      const result = await login(deps, body);
      await sendAuthResult(deps, res, 200, result);
    })().catch(next);
  });

  router.post(authPaths.refresh, (req, res, next) => {
    void (async () => {
      requireClientHeader(req);
      const result = await refresh(deps, readRefreshCookie(req));

      if (result.kind === 'invalid') {
        clearRefreshCookie(res);
        throw new AppError('SESSION_INVALID', 401, 'Refresh session is invalid or expired.');
      }
      if (result.kind === 'revoked') {
        clearRefreshCookie(res);
        throw new AppError('SESSION_REVOKED', 401, 'This session has been revoked.');
      }

      if (result.newRefreshToken !== undefined) {
        setRefreshCookie(res, result.newRefreshToken, deps.refreshTokenTtlSeconds);
      }

      res.status(200).json({
        accessToken: result.accessToken,
        accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      });
    })().catch(next);
  });

  router.post(authPaths.logout, (req, res, next) => {
    void (async () => {
      requireClientHeader(req);
      await logout(deps, readRefreshCookie(req));
      clearRefreshCookie(res);
      res.status(204).end();
    })().catch(next);
  });

  return router;
};
