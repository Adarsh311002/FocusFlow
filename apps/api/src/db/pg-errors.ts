const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;

const ownErrorCode = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const causeOf = (error: unknown): unknown => {
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return error.cause;
  }
  return undefined;
};

/**
 * Reads a PostgreSQL error code, without a type assertion (`'code'`/`'cause' in
 * error` narrows enough to destructure safely as `unknown`), unwrapping Drizzle's
 * `DrizzleQueryError` — which sets `cause` to the driver's original `pg` error
 * (with `.code`) rather than copying `.code` onto itself.
 */
const getPgErrorCode = (error: unknown): string | undefined => {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const code = ownErrorCode(current);
    if (code !== undefined) {
      return code;
    }
    const next = causeOf(current);
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return undefined;
};

/**
 * True for a unique-constraint violation (e.g. `uq_users_email`). Concurrent
 * duplicate writes (two simultaneous signups with the same email) are only ever
 * correctly prevented by the database constraint itself — any pre-check SELECT is
 * inherently racy — so callers should attempt the write and translate this error,
 * not rely on checking first.
 */
export const isUniqueViolation = (error: unknown): boolean =>
  getPgErrorCode(error) === UNIQUE_VIOLATION;
