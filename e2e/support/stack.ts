import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

// The whole stack for the end-to-end suite, started by Playwright's global setup: real
// PostgreSQL 18 and Redis in throwaway containers (the same engines as local development,
// started with Testcontainers like the API integration tests, so nothing depends on
// `pnpm infra:up` and the development database is never touched), the migrations, the API
// and the Vite dev server on their usual ports. Those ports must be free: the API and the
// web app expect each other at 127.0.0.1:3000 and localhost:5173 (apps/web/vite.config.ts).

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const API_PORT = 3000;
export const WEB_PORT = 5173;
export const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`;

const children: ChildProcess[] = [];
let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (url: string, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} did not become ready at ${url} within ${String(timeoutMs)} ms`);
    }
    await sleep(500);
  }
};

const assertPortFree = async (port: number, what: string): Promise<void> => {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return;
  }
  throw new Error(`Port ${String(port)} is in use; stop the ${what} before running the e2e suite.`);
};

const run = (args: string[], env: NodeJS.ProcessEnv, label: string): ChildProcess => {
  const child = spawn('pnpm', args, {
    cwd: REPO_ROOT,
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (process.env['E2E_VERBOSE'] === '1') {
      process.stdout.write(`[${label}] ${chunk.toString()}`);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${label}] ${chunk.toString()}`);
  });
  children.push(child);
  return child;
};

const runToEnd = (args: string[], env: NodeJS.ProcessEnv): void => {
  execFileSync('pnpm', args, { cwd: REPO_ROOT, env, shell: true, stdio: 'inherit' });
};

export const startStack = async (): Promise<void> => {
  await assertPortFree(API_PORT, 'development API');
  await assertPortFree(WEB_PORT, 'development web server');

  postgres = await new PostgreSqlContainer('postgres:18').start();
  redis = await new RedisContainer('redis:7.4-alpine').start();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'development',
    LOG_LEVEL: 'warn',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    REDIS_KEY_PREFIX: 'e2e:',
    JWT_ACCESS_SECRETS: `e2e:${randomBytes(32).toString('hex')}`,
  };

  runToEnd(['--filter', '@focus-flow/api', 'run', 'db:migrate'], env);
  run(['--filter', '@focus-flow/api', 'exec', 'tsx', 'src/main.ts'], env, 'api');
  run(['--filter', '@focus-flow/web', 'exec', 'vite'], env, 'web');

  await waitFor(`http://127.0.0.1:${String(API_PORT)}/api/v1/readyz`, 90_000, 'the API');
  await waitFor(`${WEB_ORIGIN}/`, 90_000, 'the web server');
};

export const stopStack = async (): Promise<void> => {
  for (const child of children) {
    if (child.pid !== undefined) {
      try {
        // `shell: true` means the pid is a shell; kill its whole tree.
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        child.kill();
      }
    }
  }
  children.length = 0;
  await redis?.stop();
  await postgres?.stop();
};
