import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { runWithRequestContext } from '../request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

export const readIncomingId = (header: string | string[] | undefined): string | undefined => {
  const candidate = Array.isArray(header) ? header[0] : header;
  if (candidate === undefined) {
    return undefined;
  }

  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return undefined;
  }

  // A client-supplied id ends up in logs and response headers, so only accept a
  // conservative character set.
  return SAFE_REQUEST_ID.test(trimmed) ? trimmed : undefined;
};

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const requestId = readIncomingId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  runWithRequestContext({ requestId }, next);
};
