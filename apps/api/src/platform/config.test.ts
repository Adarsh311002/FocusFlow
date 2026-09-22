import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://focusflow:focusflow@127.0.0.1:5432/focusflow',
  REDIS_URL: 'redis://127.0.0.1:6379',
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
    });

    expect(config.APP_ENV).toBe('production');
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.REDIS_KEY_PREFIX).toBe('ff-test:');
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(2500);
  });

  it('fails and names the variable when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ REDIS_URL: baseEnv.REDIS_URL })).toThrow(/DATABASE_URL/);
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
      });

    expect(attempt).toThrow(/REDIS_URL/);
    expect(attempt).not.toThrow(/hunter2|secret-port-value/);
  });
});
