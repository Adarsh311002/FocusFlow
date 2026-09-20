import { randomUUID } from 'node:crypto';

import { API_BASE_PATH } from '@focus-flow/contracts';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import pinoHttp from 'pino-http';

import { createSystemRouter } from '../../modules/system/http.js';
import type { AppConfig } from '../config.js';
import { getRequestId } from '../request-context.js';
import { createErrorHandler, notFoundHandler } from './errors.js';
import { requestIdMiddleware } from './request-id.js';

type AppDeps = {
  config: AppConfig;
  logger: Logger;
  pool: Pool;
  redis: Redis;
};

export const createApp = ({ config, logger, pool, redis }: AppDeps): Express => {
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

  app.use(API_BASE_PATH, createSystemRouter({ pool, redis }));

  app.use(notFoundHandler);

  const errorHandler: ErrorRequestHandler = createErrorHandler(logger);
  app.use(errorHandler);

  return app;
};
