import { z } from 'zod';

import { AppError } from '../../platform/http/errors.js';

// The list cursor is opaque to clients (packages/contracts/src/http/tasks.ts): today it
// is the base64url-encoded id of the last task on the previous page. Keeping it opaque
// means the encoding can change later without a contract change.

const cursorIdSchema = z.uuid();

export const encodeTaskCursor = (lastTaskId: string): string =>
  Buffer.from(lastTaskId, 'utf8').toString('base64url');

/** A cursor that does not decode to a task id is the client's mistake: 400, not a 500. */
export const decodeTaskCursor = (cursor: string): string => {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const result = cursorIdSchema.safeParse(decoded);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'The list cursor is invalid.');
  }
  return result.data;
};
