import { z } from 'zod';

const appEnvSchema = z.enum(['development', 'test', 'production']);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const requiredUrl = z.string().min(1, 'must be a non-empty connection string');

const configSchema = z.object({
  APP_ENV: appEnvSchema.default('development'),
  // Loopback by default so a development API is not exposed on the local network;
  // a container or production deployment sets HOST=0.0.0.0 explicitly.
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: requiredUrl,
  REDIS_URL: requiredUrl,
  REDIS_KEY_PREFIX: z.string().min(1).default('ff:'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
});

export type AppConfig = z.infer<typeof configSchema>;

type IssueLike = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

const describeIssues = (issues: readonly IssueLike[]): string => {
  const lines = issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return `  - ${path === '' ? '(root)' : path}: ${issue.message}`;
  });

  return lines.join('\n');
};

/**
 * Environment is validated once, at startup, so the rest of the process can treat
 * configuration as plain typed data. The env object is a parameter so tests never
 * have to mutate the real process environment.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const result = configSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  // Only variable names and validation messages are reported, never the values.
  throw new Error(`Invalid environment configuration:\n${describeIssues(result.error.issues)}`);
};
