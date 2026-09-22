import { describe, expect, it } from 'vitest';

import { errorBodySchema, errorCodeSchema } from './errors';
import { livenessResponseSchema, readinessResponseSchema } from './http/health';
import { userIdSchema } from './ids';

describe('health contracts', () => {
  it('accepts a liveness response', () => {
    expect(livenessResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it('rejects a liveness status other than "ok"', () => {
    expect(livenessResponseSchema.safeParse({ status: 'ready' }).success).toBe(false);
  });

  it('accepts a ready readiness response', () => {
    const parsed = readinessResponseSchema.parse({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    });
    expect(parsed.checks.redis).toBe('ok');
  });

  it('accepts a not-ready readiness response with an unavailable dependency', () => {
    const parsed = readinessResponseSchema.parse({
      status: 'not_ready',
      checks: { postgres: 'ok', redis: 'unavailable' },
    });
    expect(parsed.status).toBe('not_ready');
  });

  it('rejects an unknown dependency status', () => {
    const result = readinessResponseSchema.safeParse({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'degraded' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects readiness responses missing a dependency', () => {
    expect(
      readinessResponseSchema.safeParse({ status: 'ready', checks: { postgres: 'ok' } }).success,
    ).toBe(false);
  });
});

describe('error contracts', () => {
  it('accepts a well-formed error body', () => {
    const parsed = errorBodySchema.parse({
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });
    expect(parsed.error.code).toBe('NOT_FOUND');
  });

  it('rejects an unknown error code', () => {
    expect(errorCodeSchema.safeParse('TEAPOT').success).toBe(false);
  });

  it('rejects an error body without a message', () => {
    expect(errorBodySchema.safeParse({ error: { code: 'INTERNAL' } }).success).toBe(false);
  });
});

describe('branded ids', () => {
  it('parses a valid uuid into a branded id', () => {
    const value = '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11';
    expect(userIdSchema.parse(value)).toBe(value);
  });

  it('rejects a non-uuid string', () => {
    expect(userIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});
