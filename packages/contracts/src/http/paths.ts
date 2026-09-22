/**
 * Route paths the API serves and the web app calls. Owning them here means the two
 * apps cannot drift apart (for example when a future `/api/v2` appears).
 */
export const API_BASE_PATH = '/api/v1';

export const healthPaths = {
  liveness: '/healthz',
  readiness: '/readyz',
} as const;
