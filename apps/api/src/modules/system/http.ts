import { healthPaths, type LivenessResponse, type ReadinessResponse } from '@focus-flow/contracts';
import express, { type Router } from 'express';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { checkDatabase } from '../../platform/db.js';
import { checkRedis } from '../../platform/redis.js';

type SystemDeps = {
  pool: Pool;
  redis: Redis;
};

const readReadiness = async (pool: Pool, redis: Redis): Promise<ReadinessResponse> => {
  const [postgres, redisStatus] = await Promise.all([checkDatabase(pool), checkRedis(redis)]);
  const ready = postgres === 'ok' && redisStatus === 'ok';

  return {
    status: ready ? 'ready' : 'not_ready',
    checks: { postgres, redis: redisStatus },
  };
};

export const createSystemRouter = ({ pool, redis }: SystemDeps): Router => {
  const router = express.Router();

  // Liveness answers "is this process running": it must never touch a dependency,
  // otherwise an orchestrator would restart a healthy process (decision P2).
  router.get(healthPaths.liveness, (_req, res) => {
    const body: LivenessResponse = { status: 'ok' };
    res.status(200).json(body);
  });

  router.get(healthPaths.readiness, (_req, res, next) => {
    readReadiness(pool, redis)
      .then((body) => {
        res.status(body.status === 'ready' ? 200 : 503).json(body);
      })
      .catch((error: unknown) => {
        next(error);
      });
  });

  return router;
};
