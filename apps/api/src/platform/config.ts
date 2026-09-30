import { z } from 'zod';

const appEnvSchema = z.enum(['development', 'test', 'production']);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const requiredUrl = z.string().min(1, 'must be a non-empty connection string');
/** A duration in milliseconds: 100 ms (tests) to 10 minutes. */
const durationMs = z.coerce.number().int().min(100).max(600_000);

export type JwtSigningKey = { readonly kid: string; readonly secret: string };

const MIN_JWT_SECRET_LENGTH = 32;

/**
 * "kid:secret" pairs, comma-separated. The first pair is the active signing key;
 * every pair is accepted for verification, so a new key can be deployed ahead of a
 * rotation and the old one removed once nothing still holds a token signed with it.
 */
const jwtAccessSecretsSchema = z
  .string()
  .min(1, 'must contain at least one "kid:secret" pair')
  .transform((raw, ctx): JwtSigningKey[] => {
    const keys: JwtSigningKey[] = [];
    const seenKids = new Set<string>();

    for (const entry of raw.split(',')) {
      const pair = entry.trim();
      if (pair.length === 0) {
        continue;
      }

      const separatorIndex = pair.indexOf(':');
      if (separatorIndex <= 0) {
        ctx.addIssue({ code: 'custom', message: `"${pair}" is not in "kid:secret" form` });
        return z.NEVER;
      }

      const kid = pair.slice(0, separatorIndex);
      const secret = pair.slice(separatorIndex + 1);

      if (secret.length < MIN_JWT_SECRET_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: `the secret for key "${kid}" must be at least ${MIN_JWT_SECRET_LENGTH} characters`,
        });
        return z.NEVER;
      }
      if (seenKids.has(kid)) {
        ctx.addIssue({ code: 'custom', message: `key id "${kid}" is duplicated` });
        return z.NEVER;
      }
      seenKids.add(kid);
      keys.push({ kid, secret });
    }

    if (keys.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'must contain at least one "kid:secret" pair' });
      return z.NEVER;
    }

    return keys;
  });

const configSchema = z
  .object({
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

    // Auth (Phase 1, docs/architecture/auth.md).
    JWT_ACCESS_SECRETS: jwtAccessSecretsSchema,
    JWT_ISSUER: z.string().min(1).default('focus-flow'),
    JWT_AUDIENCE: z.string().min(1).default('focus-flow'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3_600)
      .max(31_536_000)
      .default(2_592_000),
    REFRESH_OVERLAP_SECONDS: z.coerce.number().int().min(5).max(120).default(20),

    // Real-time foundation (Phase 3, docs/architecture/redis-keys.md). All durations are
    // configurable so tests can run the same code with short intervals.
    /** Fixed instance id; normally unset, so every process start is a new instance. */
    INSTANCE_ID: z.uuid().optional(),
    INSTANCE_HEARTBEAT_MS: durationMs.default(10_000),
    /** An instance whose last heartbeat is older than this is dead. */
    INSTANCE_TTL_MS: durationMs.default(30_000),
    /** Socket.IO ping settings: a silently dropped client is detected within their sum. */
    SOCKET_PING_INTERVAL_MS: durationMs.default(10_000),
    SOCKET_PING_TIMEOUT_MS: durationMs.default(10_000),
  })
  .refine((config) => config.INSTANCE_TTL_MS >= 2 * config.INSTANCE_HEARTBEAT_MS, {
    path: ['INSTANCE_TTL_MS'],
    message: 'must be at least twice INSTANCE_HEARTBEAT_MS, so one late heartbeat is not a death',
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
