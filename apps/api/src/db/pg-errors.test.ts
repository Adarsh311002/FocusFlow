import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from './pg-errors.js';

describe('isUniqueViolation', () => {
  it('detects a raw pg error with code 23505', () => {
    expect(isUniqueViolation(Object.assign(new Error('duplicate'), { code: '23505' }))).toBe(true);
  });

  it("detects Drizzle's DrizzleQueryError, which wraps the real pg error as `cause`", () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const wrapped = new Error('Failed query: insert into "users" ...', { cause: pgError });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('unwraps multiple levels of cause', () => {
    const pgError = Object.assign(new Error('duplicate'), { code: '23505' });
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: pgError }) });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('is false for an unrelated PostgreSQL error code', () => {
    expect(isUniqueViolation(Object.assign(new Error('not null'), { code: '23502' }))).toBe(false);
  });

  it('is false for a plain error with no code anywhere in the cause chain', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
  });

  it('is false for non-error values', () => {
    expect(isUniqueViolation('a string')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('does not loop forever on a self-referencing cause chain', () => {
    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    expect(isUniqueViolation(circular)).toBe(false);
  });
});
