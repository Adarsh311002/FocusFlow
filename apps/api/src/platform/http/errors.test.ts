import { errorBodySchema } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  createErrorHandler,
  type ErrorHandlerLogger,
  type ErrorHandlerRequest,
  type ErrorHandlerResponse,
  internal,
  notFound,
  notFoundHandler,
  parseRequestBody,
  RequestValidationError,
} from './errors.js';

type LoggedLine = { details: Parameters<ErrorHandlerLogger['error']>[0]; message: string };

const request: ErrorHandlerRequest = { method: 'GET', path: '/api/v1/things' };

const createHarness = (headersSent = false) => {
  const sent: { status?: number; body?: unknown } = {};
  const logged: LoggedLine[] = [];
  const nextCalls: unknown[] = [];

  const res: ErrorHandlerResponse = {
    headersSent,
    status(code) {
      sent.status = code;
      return res;
    },
    json(body) {
      sent.body = body;
      return res;
    },
  };

  const logger: ErrorHandlerLogger = {
    error(details, message) {
      logged.push({ details, message });
    },
  };

  const handle = createErrorHandler(logger);

  return {
    sent,
    logged,
    nextCalls,
    run(error: unknown) {
      handle(error, request, res, (forwarded) => {
        nextCalls.push(forwarded);
      });
    },
  };
};

const makeZodError = () => {
  const result = z.object({ title: z.string() }).safeParse({ title: 42 });
  if (result.success) {
    throw new Error('expected the fixture schema to fail');
  }
  return result.error;
};

describe('AppError', () => {
  it('carries the code, status and details', () => {
    const error = new AppError('VALIDATION_FAILED', 422, 'bad input', { field: 'title' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.message).toBe('bad input');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ field: 'title' });
  });

  it('builds 404 and 500 errors through the helpers', () => {
    expect(notFound('missing')).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(internal('boom')).toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(notFound('missing').details).toBeUndefined();
  });
});

describe('parseRequestBody', () => {
  const schema = z.object({ title: z.string() });

  it('returns the parsed value on success', () => {
    expect(parseRequestBody(schema, { title: 'ok' })).toEqual({ title: 'ok' });
  });

  it('throws a RequestValidationError on failure', () => {
    expect(() => parseRequestBody(schema, { title: 42 })).toThrow(RequestValidationError);
  });
});

describe('notFoundHandler', () => {
  it('answers 404 with the shared error envelope', () => {
    const sent: { status?: number; body?: unknown } = {};
    const res: ErrorHandlerResponse = {
      headersSent: false,
      status(code) {
        sent.status = code;
        return res;
      },
      json(body) {
        sent.body = body;
        return res;
      },
    };

    notFoundHandler(request, res);

    expect(sent.status).toBe(404);
    const body = errorBodySchema.parse(sent.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/api/v1/things');
  });
});

describe('createErrorHandler', () => {
  it('maps an AppError to its own status and code', () => {
    const harness = createHarness();

    harness.run(new AppError('NOT_FOUND', 404, 'room not found'));

    expect(harness.sent.status).toBe(404);
    expect(errorBodySchema.parse(harness.sent.body)).toEqual({
      error: { code: 'NOT_FOUND', message: 'room not found' },
    });
    expect(harness.logged).toHaveLength(0);
  });

  it('maps a RequestValidationError (from parseRequestBody) to 400 VALIDATION_FAILED with details', () => {
    const harness = createHarness();

    harness.run(new RequestValidationError(makeZodError()));

    expect(harness.sent.status).toBe(400);
    const body = errorBodySchema.parse(harness.sent.body);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toBeDefined();
    expect(harness.logged).toHaveLength(0);
  });

  it('treats a bare ZodError (not raised via parseRequestBody) as an internal failure', () => {
    // A ZodError thrown by a server-side sanity check (e.g. validating a value just
    // read back from the database) is a bug, not a client mistake, so it must not be
    // confused with client input validation and leaked back as a 400.
    const harness = createHarness();

    harness.run(makeZodError());

    expect(harness.sent.status).toBe(500);
    expect(errorBodySchema.parse(harness.sent.body)).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    expect(harness.logged).toHaveLength(1);
  });

  it('maps a malformed-body error from Express middleware to a 400, not a 500', () => {
    const harness = createHarness();
    const fromBodyParser = Object.assign(new SyntaxError('Unexpected token } in JSON at 12'), {
      status: 400,
      expose: true,
    });

    harness.run(fromBodyParser);

    expect(harness.sent.status).toBe(400);
    expect(harness.sent.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Request body is malformed' },
    });
    expect(harness.logged).toHaveLength(0);
  });

  it('maps an oversized-body error from Express middleware to a 413', () => {
    const harness = createHarness();
    const tooLarge = Object.assign(new Error('request entity too large: 20000 > 16384'), {
      status: 413,
      expose: true,
    });

    harness.run(tooLarge);

    expect(harness.sent.status).toBe(413);
    expect(harness.sent.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Request body is too large' },
    });
    expect(JSON.stringify(harness.sent.body)).not.toContain('20000');
  });

  it('treats an error with a status but no expose flag as an internal failure', () => {
    const harness = createHarness();

    harness.run(Object.assign(new Error('driver failure'), { status: 400 }));

    expect(harness.sent.status).toBe(500);
    expect(harness.logged).toHaveLength(1);
  });

  it('does not leak the message or details of an AppError with a 5xx status', () => {
    const harness = createHarness();
    const original = new AppError('INTERNAL', 503, 'pool exhausted for db.internal:5432', {
      dsn: 'postgres://user:secret@db.internal/app',
    });

    harness.run(original);

    expect(harness.sent.status).toBe(503);
    expect(harness.sent.body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    expect(JSON.stringify(harness.sent.body)).not.toContain('secret');
    expect(harness.logged).toHaveLength(1);
    expect(harness.logged[0]?.details.err).toBe(original);
  });

  it('maps an unknown error to a generic 500 without leaking its message', () => {
    const harness = createHarness();
    const original = new Error('connection string postgres://user:secret@host/db failed');

    harness.run(original);

    expect(harness.sent.status).toBe(500);
    const body = errorBodySchema.parse(harness.sent.body);
    expect(body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(JSON.stringify(body)).not.toContain('secret');

    expect(harness.logged).toHaveLength(1);
    expect(harness.logged[0]?.details.err).toBe(original);
    expect(harness.logged[0]?.details.method).toBe('GET');
    expect(harness.logged[0]?.details.path).toBe('/api/v1/things');
  });

  it('delegates to next when the response has already started', () => {
    const harness = createHarness(true);
    const error = new AppError('INTERNAL', 500, 'too late');

    harness.run(error);

    expect(harness.nextCalls).toEqual([error]);
    expect(harness.sent.status).toBeUndefined();
  });
});
