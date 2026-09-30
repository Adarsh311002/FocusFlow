import { describe, expect, it } from 'vitest';

import { AppError } from '../../platform/http/errors.js';
import { decodeTaskCursor, encodeTaskCursor } from './cursor.js';

const TASK_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';

const decodeError = (cursor: string): unknown => {
  try {
    decodeTaskCursor(cursor);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('task list cursor', () => {
  it('round-trips a task id', () => {
    expect(decodeTaskCursor(encodeTaskCursor(TASK_ID))).toBe(TASK_ID);
  });

  it('is URL-safe and does not expose the raw id', () => {
    const cursor = encodeTaskCursor(TASK_ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(TASK_ID);
  });

  it.each([
    ['garbage', 'not-a-cursor!'],
    ['a valid base64url value that is not a task id', Buffer.from('hello').toString('base64url')],
    ['a raw uuid', TASK_ID],
  ])('rejects %s with a 400 VALIDATION_FAILED', (_label, cursor) => {
    const error = decodeError(cursor);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });
});
