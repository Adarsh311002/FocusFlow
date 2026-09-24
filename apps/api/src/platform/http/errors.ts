import type { ErrorBody, ErrorCode } from '@focus-flow/contracts';
import { z } from 'zod';

import { getRequestId } from '../request-context.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export const notFound = (message: string): AppError => new AppError('NOT_FOUND', 404, message);

export const internal = (message: string): AppError => new AppError('INTERNAL', 500, message);

export const errorBody = (code: ErrorCode, message: string, details?: unknown): ErrorBody =>
  details === undefined ? { error: { code, message } } : { error: { code, message, details } };

/**
 * Thrown only by `parseRequestBody` below. Handlers use that helper (not a bare
 * `schema.parse(...)`) for anything that came from the client, so the error handler
 * can map exactly this type to 400 — never a `z.ZodError` raised anywhere else, such
 * as a sanity check on a value already read back from the database, which is a server
 * bug and must surface as a 500.
 */
export class RequestValidationError extends AppError {
  constructor(zodError: z.ZodError) {
    super('VALIDATION_FAILED', 400, 'Request validation failed', z.flattenError(zodError));
    this.name = 'RequestValidationError';
  }
}

export const parseRequestBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new RequestValidationError(result.error);
  }
  return result.data;
};

/**
 * Narrow structural types: the handlers only need these members, which keeps them
 * unit-testable with plain typed stubs while staying assignable to Express's
 * RequestHandler and ErrorRequestHandler. Widen them when a handler needs more of
 * the request (for example an authenticated user) instead of casting.
 */
export type ErrorHandlerRequest = {
  method: string;
  path: string;
};

export type ErrorHandlerResponse = {
  headersSent: boolean;
  status: (code: number) => ErrorHandlerResponse;
  json: (body: ErrorBody) => unknown;
};

export type ErrorHandlerLogger = {
  error: (
    details: { err: unknown; requestId: string | undefined; method: string; path: string },
    message: string,
  ) => void;
};

export const notFoundHandler = (req: ErrorHandlerRequest, res: ErrorHandlerResponse): void => {
  res.status(404).json(errorBody('NOT_FOUND', `No route matches ${req.method} ${req.path}`));
};

export type ApiErrorHandler = (
  err: unknown,
  req: ErrorHandlerRequest,
  res: ErrorHandlerResponse,
  next: (error: unknown) => void,
) => void;

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/**
 * Errors raised by Express's own middleware (for example `express.json` on malformed
 * or oversized bodies) carry a 4xx `status` and `expose: true`. They are the client's
 * mistake, not a server failure, so they must not become a 500.
 */
const readClientHttpStatus = (err: unknown): number | undefined => {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  if (!('status' in err) || !('expose' in err) || err.expose !== true) {
    return undefined;
  }
  const { status } = err;
  return typeof status === 'number' && status >= HTTP_BAD_REQUEST && status < 500
    ? status
    : undefined;
};

// Fixed messages: the framework's own wording can echo request content.
const clientHttpMessage = (status: number): string => {
  if (status === HTTP_BAD_REQUEST) {
    return 'Request body is malformed';
  }
  if (status === HTTP_PAYLOAD_TOO_LARGE) {
    return 'Request body is too large';
  }
  return 'Invalid request';
};

export const createErrorHandler = (logger: ErrorHandlerLogger): ApiErrorHandler => {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    // Client errors carry a message written for the client. A server error never
    // does, even when it is an AppError: its message and details may name internals.
    if (err instanceof AppError && err.status < 500) {
      res.status(err.status).json(errorBody(err.code, err.message, err.details));
      return;
    }

    const clientStatus = readClientHttpStatus(err);
    if (clientStatus !== undefined) {
      res
        .status(clientStatus)
        .json(errorBody('VALIDATION_FAILED', clientHttpMessage(clientStatus)));
      return;
    }

    // A bare z.ZodError (as opposed to the RequestValidationError that
    // parseRequestBody raises for client input) means something server-side failed a
    // sanity check against data that was never meant to reach the client raw — that is
    // a bug, not a client mistake, so it falls through to the generic 500 below.

    // The client gets a generic message; the real error only goes to the log.
    logger.error(
      { err, requestId: getRequestId(), method: req.method, path: req.path },
      'Unhandled request error',
    );
    res
      .status(err instanceof AppError ? err.status : 500)
      .json(errorBody('INTERNAL', 'Internal server error'));
  };
};
