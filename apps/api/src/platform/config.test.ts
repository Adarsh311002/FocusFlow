import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const validJwtSecret = 'k1:0123456789abcdef0123456789abcdef';

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://focusflow:focusflow@127.0.0.1:5432/focusflow',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_ACCESS_SECRETS: validJwtSecret,
};

describe('loadConfig', () => {
  it('parses a minimal environment and applies the defaults', () => {
    const config = loadConfig(baseEnv);

    expect(config).toEqual({
      APP_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: baseEnv.DATABASE_URL,
      REDIS_URL: baseEnv.REDIS_URL,
      REDIS_KEY_PREFIX: 'ff:',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      JWT_ACCESS_SECRETS: [{ kid: 'k1', secret: '0123456789abcdef0123456789abcdef' }],
      JWT_ISSUER: 'focus-flow',
      JWT_AUDIENCE: 'focus-flow',
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
      REFRESH_OVERLAP_SECONDS: 20,
      INSTANCE_HEARTBEAT_MS: 10_000,
      INSTANCE_TTL_MS: 30_000,
    });
  });

  describe('real-time settings', () => {
    it('accepts an explicit instance id and intervals', () => {
      const config = loadConfig({
        ...baseEnv,
        INSTANCE_ID: '01a0ed0d-55de-7d1b-8495-82fb5050d815',
        INSTANCE_HEARTBEAT_MS: '500',
        INSTANCE_TTL_MS: '1500',
      });
      expect(config.INSTANCE_ID).toBe('01a0ed0d-55de-7d1b-8495-82fb5050d815');
      expect(config.INSTANCE_HEARTBEAT_MS).toBe(500);
      expect(config.INSTANCE_TTL_MS).toBe(1500);
    });

    it('rejects an instance id that is not a UUID', () => {
      expect(() => loadConfig({ ...baseEnv, INSTANCE_ID: 'api-1' })).toThrow(/INSTANCE_ID/);
    });

    it('rejects a TTL shorter than two heartbeats', () => {
      expect(() =>
        loadConfig({ ...baseEnv, INSTANCE_HEARTBEAT_MS: '10000', INSTANCE_TTL_MS: '15000' }),
      ).toThrow(/INSTANCE_TTL_MS/);
    });

    it('rejects durations below 100 ms', () => {
      expect(() => loadConfig({ ...baseEnv, INSTANCE_HEARTBEAT_MS: '50' })).toThrow(
        /INSTANCE_HEARTBEAT_MS/,
      );
    });
  });

  it('keeps explicitly provided values', () => {
    const config = loadConfig({
      ...baseEnv,
      APP_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      REDIS_KEY_PREFIX: 'ff-test:',
      SHUTDOWN_TIMEOUT_MS: '2500',
      JWT_ISSUER: 'focus-flow-staging',
      JWT_AUDIENCE: 'focus-flow-staging',
      ACCESS_TOKEN_TTL_SECONDS: '300',
      REFRESH_TOKEN_TTL_SECONDS: '86400',
      REFRESH_OVERLAP_SECONDS: '5',
    });

    expect(config.APP_ENV).toBe('production');
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.REDIS_KEY_PREFIX).toBe('ff-test:');
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(2500);
    expect(config.JWT_ISSUER).toBe('focus-flow-staging');
    expect(config.JWT_AUDIENCE).toBe('focus-flow-staging');
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(300);
    expect(config.REFRESH_TOKEN_TTL_SECONDS).toBe(86_400);
    expect(config.REFRESH_OVERLAP_SECONDS).toBe(5);
  });

  it('fails and names the variable when DATABASE_URL is missing', () => {
    expect(() =>
      loadConfig({ REDIS_URL: baseEnv.REDIS_URL, JWT_ACCESS_SECRETS: validJwtSecret }),
    ).toThrow(/DATABASE_URL/);
  });

  it('fails when a required connection string is empty', () => {
    expect(() => loadConfig({ ...baseEnv, REDIS_URL: '' })).toThrow(/REDIS_URL/);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects an unknown APP_ENV', () => {
    expect(() => loadConfig({ ...baseEnv, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });

  it('never includes a configured value in the failure message', () => {
    const attempt = (): unknown =>
      loadConfig({
        DATABASE_URL: 'postgres://user:hunter2@db.internal/app',
        REDIS_URL: '',
        PORT: 'secret-port-value',
        JWT_ACCESS_SECRETS: validJwtSecret,
      });

    expect(attempt).toThrow(/REDIS_URL/);
    expect(attempt).not.toThrow(/hunter2|secret-port-value/);
  });

  describe('JWT_ACCESS_SECRETS', () => {
    it('parses multiple "kid:secret" pairs, keeping the first as the active key', () => {
      const config = loadConfig({
        ...baseEnv,
        JWT_ACCESS_SECRETS:
          'k2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,k1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });

      expect(config.JWT_ACCESS_SECRETS).toEqual([
        { kid: 'k2', secret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { kid: 'k1', secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ]);
    });

    it('rejects an entry with no "kid:secret" separator', () => {
      expect(() => loadConfig({ ...baseEnv, JWT_ACCESS_SECRETS: 'not-a-pair' })).toThrow(
        /kid:secret/,
      );
    });

    it('rejects a secret shorter than 32 characters', () => {
      expect(() => loadConfig({ ...baseEnv, JWT_ACCESS_SECRETS: 'k1:tooshort' })).toThrow(
        /at least 32 characters/,
      );
    });

    it('rejects a duplicated key id', () => {
      const oneSecret = '0123456789abcdef0123456789abcdef';
      expect(() =>
        loadConfig({ ...baseEnv, JWT_ACCESS_SECRETS: `k1:${oneSecret},k1:${oneSecret}` }),
      ).toThrow(/duplicated/);
    });

    it('never includes a secret value in the failure message', () => {
      const attempt = (): unknown => loadConfig({ ...baseEnv, JWT_ACCESS_SECRETS: 'k1:tooshort' });

      expect(attempt).toThrow();
      expect(attempt).not.toThrow(/tooshort/);
    });
  });
});
