import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';

import {
  HTTP_GLOBAL_RATE,
  LOGIN_RATE,
  type RateLimiter,
  type RateRule,
  REFRESH_RATE,
  SIGNUP_RATE,
} from '../../modules/room-realtime/limiter.js';
import { AppError } from './errors.js';

// REST rate limiting (Phase 9). Fixed-window counters in Redis (`ff:ratelimit:{action}:{subject}`),
// keyed by client address for anonymous routes and by user id for authenticated ones.
//  - A refused request answers `429 RATE_LIMITED` with a `Retry-After` header.
//  - Credential routes and per-user abuse limits fail CLOSED (503) when Redis cannot count;
//    the broad per-address limit fails OPEN (logged), so a Redis blip does not take the API down.
//  - `req.ip` honours `trust proxy` (set in production), so it is the real client behind Nginx.

export type RateLimitMode = 'open' | 'closed';

export type HttpRateLimits = {
  /** Middleware for the whole API under its base path. */
  readonly global: RequestHandler;
  readonly login: RequestHandler;
  readonly signup: RequestHandler;
  readonly refresh: RequestHandler;
  /** Per-user check for authenticated routes; throws `AppError` when refused. */
  readonly checkUser: (
    rule: RateRule,
    userId: string,
    res: { setHeader: (n: string, v: string) => unknown },
  ) => Promise<void>;
};

const clientAddress = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export const createHttpRateLimits = (deps: {
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly enabled: boolean;
}): HttpRateLimits => {
  const { limiter, logger, enabled } = deps;

  const enforce = async (
    rule: RateRule,
    subject: string,
    mode: RateLimitMode,
    res: { setHeader: (n: string, v: string) => unknown },
  ): Promise<void> => {
    if (!enabled) {
      return;
    }
    let decision;
    try {
      decision = await limiter.hit(rule, subject);
    } catch (error) {
      if (mode === 'open') {
        logger.warn({ err: error, action: rule.action }, 'Rate limiting unavailable; allowing');
        return;
      }
      throw new AppError('INTERNAL', 503, 'Rate limiting is temporarily unavailable.');
    }
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new AppError('RATE_LIMITED', 429, 'Too many requests. Slow down.');
    }
  };

  const byAddress =
    (rule: RateRule, mode: RateLimitMode): RequestHandler =>
    (req, res, next) => {
      enforce(rule, clientAddress(req), mode, res).then(() => {
        next();
      }, next);
    };

  const global: RequestHandler = (req, res, next) => {
    // Health checks are probes from the platform, never rate limited.
    if (req.path === '/healthz' || req.path === '/readyz') {
      next();
      return;
    }
    byAddress(HTTP_GLOBAL_RATE, 'open')(req, res, next);
  };

  return {
    global,
    login: byAddress(LOGIN_RATE, 'closed'),
    signup: byAddress(SIGNUP_RATE, 'closed'),
    refresh: byAddress(REFRESH_RATE, 'closed'),
    checkUser: (rule, userId, res) => enforce(rule, userId, 'closed', res),
  };
};
