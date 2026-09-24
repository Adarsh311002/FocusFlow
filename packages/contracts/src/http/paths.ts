/**
 * Route paths the API serves and the web app calls. Owning them here means the two
 * apps cannot drift apart (for example when a future `/api/v2` appears).
 */
export const API_BASE_PATH = '/api/v1';

export const healthPaths = {
  liveness: '/healthz',
  readiness: '/readyz',
} as const;

export const authPaths = {
  signup: '/auth/signup',
  login: '/auth/login',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
} as const;

export const mePaths = {
  self: '/me',
} as const;

/**
 * Required on every refresh/logout request in addition to the refresh cookie: a
 * bare cross-site form submission cannot set a custom header, so this blocks the
 * classic "browser automatically attaches the cookie" CSRF pattern
 * (docs/architecture/auth.md). Shared here so the API and the web client cannot
 * drift on the exact header name.
 */
export const CLIENT_HEADER_NAME = 'x-focus-flow-client';
