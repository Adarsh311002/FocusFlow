import { randomUUID } from 'node:crypto';

import { API_BASE_PATH, authPaths } from '@focus-flow/contracts';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import pinoHttp from 'pino-http';

import { createAuthRouter } from '../../modules/auth/http.js';
import { requireAuth } from '../../modules/auth/middleware.js';
import type { AuthDeps } from '../../modules/auth/service.js';
import { createFocusSessionsRouter } from '../../modules/focus-sessions/http.js';
import type { FocusSessionsDeps } from '../../modules/focus-sessions/service.js';
import { createForestRouter } from '../../modules/forest/http.js';
import { createGoalsRouter } from '../../modules/goals/http.js';
import { createParkedThoughtsRouter } from '../../modules/parked-thoughts/http.js';
import { createRoomFocusRouter } from '../../modules/room-focus/http.js';
import type { RoomFocusService } from '../../modules/room-focus/types.js';
import { createRateLimiter, ROOM_FOCUS_RATE } from '../../modules/room-realtime/limiter.js';
import { createRoomsRouter } from '../../modules/rooms/http.js';
import type { RoomsDeps } from '../../modules/rooms/service.js';
import { createStepsRouter } from '../../modules/steps/http.js';
import { createSystemRouter } from '../../modules/system/http.js';
import { createTasksRouter } from '../../modules/tasks/http.js';
import { createUsersRouter } from '../../modules/users/http.js';
import { createWeeklyPrioritiesRouter } from '../../modules/weekly-priorities/http.js';
import type { AppConfig } from '../config.js';
import { getRequestId } from '../request-context.js';
import { createErrorHandler, notFoundHandler } from './errors.js';
import { createHttpRateLimits } from './rate-limit.js';
import { requestIdMiddleware } from './request-id.js';

type AppDeps = {
  config: AppConfig;
  logger: Logger;
  pool: Pool;
  redis: Redis;
  authDeps: AuthDeps;
  focusSessions: Omit<FocusSessionsDeps, 'db'>;
  rooms: Omit<RoomsDeps, 'db'>;
  roomFocus: RoomFocusService;
};

export const createApp = ({
  config,
  logger,
  pool,
  redis,
  authDeps,
  focusSessions,
  rooms,
  roomFocus,
}: AppDeps): Express => {
  const roomFocusLimiter = createRateLimiter(redis);
  const limits = createHttpRateLimits({
    limiter: roomFocusLimiter,
    logger,
    enabled: config.HTTP_RATE_LIMIT === 'on',
  });
  const app = express();

  app.disable('x-powered-by');

  if (config.APP_ENV === 'production') {
    // Behind a reverse proxy the client address and protocol come from its headers.
    app.set('trust proxy', 1);
  }

  // The request id is established first so both HTTP logs and error logs carry it.
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: () => getRequestId() ?? randomUUID(),
    }),
  );
  app.use(express.json({ limit: '16kb' }));

  // Rate limits (Phase 9): the broad per-address limit first, then the credential routes.
  app.use(API_BASE_PATH, limits.global);
  app.post(`${API_BASE_PATH}${authPaths.login}`, limits.login);
  app.post(`${API_BASE_PATH}${authPaths.signup}`, limits.signup);
  app.post(`${API_BASE_PATH}${authPaths.refresh}`, limits.refresh);

  app.use(API_BASE_PATH, createSystemRouter({ pool, redis }));
  app.use(API_BASE_PATH, createAuthRouter(authDeps));
  app.use(API_BASE_PATH, createUsersRouter(authDeps));
  app.use(
    API_BASE_PATH,
    createTasksRouter({ db: authDeps.db, authenticate: requireAuth(authDeps) }),
  );
  app.use(
    API_BASE_PATH,
    createStepsRouter({ db: authDeps.db, authenticate: requireAuth(authDeps) }),
  );
  app.use(
    API_BASE_PATH,
    createGoalsRouter({ db: authDeps.db, authenticate: requireAuth(authDeps) }),
  );
  app.use(
    API_BASE_PATH,
    createParkedThoughtsRouter({ db: authDeps.db, authenticate: requireAuth(authDeps) }),
  );
  app.use(
    API_BASE_PATH,
    createWeeklyPrioritiesRouter({ db: authDeps.db, authenticate: requireAuth(authDeps) }),
  );
  app.use(
    API_BASE_PATH,
    createForestRouter({ db: authDeps.db, authenticate: requireAuth(authDeps) }),
  );
  app.use(
    API_BASE_PATH,
    createFocusSessionsRouter({
      ...focusSessions,
      db: authDeps.db,
      authenticate: requireAuth(authDeps),
    }),
  );

  app.use(
    API_BASE_PATH,
    createRoomsRouter({
      ...rooms,
      db: authDeps.db,
      authenticate: requireAuth(authDeps),
      limit: limits.checkUser,
    }),
  );

  app.use(
    API_BASE_PATH,
    createRoomFocusRouter({
      service: roomFocus,
      authenticate: requireAuth(authDeps),
      rateLimit: (userId) => roomFocusLimiter.consume(ROOM_FOCUS_RATE, userId),
    }),
  );

  app.use(notFoundHandler);

  const errorHandler: ErrorRequestHandler = createErrorHandler(logger);
  app.use(errorHandler);

  return app;
};
