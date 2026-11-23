import { z } from 'zod';

import { AppError } from '../../platform/http/errors.js';

// The history cursor is opaque to clients (packages/contracts/src/http/focus-sessions.ts):
// today it is the base64url-encoded id of the last session on the previous page. The
// query resolves that session's `(started_at, id)` position itself, scoped to the
// requesting user, so a cursor never carries a timestamp whose precision could drift and a
// cursor naming someone else's session is simply invalid (V2).

const cursorIdSchema = z.uuid();

export const encodeHistoryCursor = (lastSessionId: string): string =>
  Buffer.from(lastSessionId, 'utf8').toString('base64url');

export const invalidHistoryCursor = (): AppError =>
  new AppError('VALIDATION_FAILED', 400, 'The list cursor is invalid.');

/** A cursor that does not decode to a session id is the client's mistake: 400, not a 500. */
export const decodeHistoryCursor = (cursor: string): string => {
  const result = cursorIdSchema.safeParse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!result.success) {
    throw invalidHistoryCursor();
  }
  return result.data;
};
