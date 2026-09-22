import { type Logger, pino } from 'pino';

import type { AppConfig } from './config.js';

// Headers and fields that carry credentials. Request URLs are logged by pino-http,
// so secrets must never travel in query strings (they would not be redacted here).
const redactedPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
];

export const createLogger = (config: AppConfig): Logger => {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: redactedPaths, censor: '[redacted]' },
  });
};
