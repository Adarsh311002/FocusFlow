import type { FocusSessionId, RoomId, TaskId, UserId } from '../ids';

/**
 * Route paths the API serves and the web app calls. Owning them here means the two
 * apps cannot drift apart (for example when a future `/api/v2` appears).
 */
export const API_BASE_PATH = '/api/v1';

/**
 * Where the Socket.IO server listens and the client connects. Same origin as the app (the
 * Vite dev proxy and, later, Nginx forward it to the API), so no CORS is involved.
 */
export const SOCKET_IO_PATH = '/socket.io';

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
  currentTask: '/me/current-task',
} as const;

/** Grow your forest (GF5). */
export const forestPaths = { self: '/forest' } as const;

/** Weekly priorities (WR2). */
export const weeklyPriorityPaths = { collection: '/weekly-priorities' } as const;

/** Parked thoughts (PT2). */
export const parkedThoughtPaths = {
  collection: '/parked-thoughts',
  item: '/parked-thoughts/:thoughtId',
  toTask: '/parked-thoughts/:thoughtId/task',
} as const;

/** Builds a concrete parked-thought URL path. */
export const parkedThoughtPath = (
  template: (typeof parkedThoughtPaths)['item' | 'toTask'],
  thoughtId: string,
): string => template.replace(':thoughtId', encodeURIComponent(thoughtId));

/** Express-style templates; the web app fills in `:taskId` with `taskPath`. */
export const taskPaths = {
  collection: '/tasks',
  item: '/tasks/:taskId',
  complete: '/tasks/:taskId/complete',
  reopen: '/tasks/:taskId/reopen',
  /** SP2. */
  steps: '/tasks/:taskId/steps',
} as const;

/** Steps of one task (SP2). */
export const taskStepPath = (taskId: string, stepId?: string): string =>
  `/tasks/${encodeURIComponent(taskId)}/steps${stepId === undefined ? '' : `/${encodeURIComponent(stepId)}`}`;

/** Wave 4: buddies (BD3), room schedules (SC2), upcoming sessions (SC3), room recap (RR1). */
export const togetherPaths = {
  buddies: '/buddies',
  buddy: '/buddies/:userId',
  acceptBuddy: '/buddies/:userId/accept',
  nudgeBuddy: '/buddies/:userId/nudge',
  schedules: '/rooms/:roomId/schedules',
  schedule: '/rooms/:roomId/schedules/:scheduleId',
  upcoming: '/me/upcoming-sessions',
  recap: '/rooms/:roomId/recap',
} as const;

/** Goals (GL3). */
export const goalPaths = { collection: '/goals', item: '/goals/:goalId' } as const;

export const goalPath = (goalId: string): string => `/goals/${encodeURIComponent(goalId)}`;

export type TaskPathTemplate = Exclude<(typeof taskPaths)[keyof typeof taskPaths], '/tasks'>;

/** Builds a concrete task URL path from one of the `taskPaths` templates. */
export const taskPath = (template: TaskPathTemplate, taskId: TaskId): string =>
  template.replace(':taskId', encodeURIComponent(taskId));

/** Solo focus sessions (Phase 4B, docs/api/rest.md "Focus sessions"). */
export const focusSessionPaths = {
  collection: '/focus-sessions',
  current: '/focus-sessions/current',
  summary: '/focus-sessions/summary',
  insights: '/focus-sessions/insights',
  pause: '/focus-sessions/:sessionId/pause',
  resume: '/focus-sessions/:sessionId/resume',
  stop: '/focus-sessions/:sessionId/stop',
  checkIn: '/focus-sessions/:sessionId/check-in',
} as const;

export type FocusSessionPathTemplate = (typeof focusSessionPaths)[
  'pause' | 'resume' | 'stop' | 'checkIn'];

/** Builds a concrete focus-session URL path from one of the per-session templates. */
export const focusSessionPath = (
  template: FocusSessionPathTemplate,
  sessionId: FocusSessionId,
): string => template.replace(':sessionId', encodeURIComponent(sessionId));

/**
 * Required on every refresh/logout request in addition to the refresh cookie: a
 * bare cross-site form submission cannot set a custom header, so this blocks the
 * classic "browser automatically attaches the cookie" CSRF pattern
 * (docs/architecture/auth.md). Shared here so the API and the web client cannot
 * drift on the exact header name.
 */
export const CLIENT_HEADER_NAME = 'x-focus-flow-client';

/** Rooms and membership (Phase 6, docs/api/rest.md "Rooms"). */
export const roomPaths = {
  collection: '/rooms',
  byCode: '/rooms/by-code/:code',
  item: '/rooms/:roomId',
  timerSettings: '/rooms/:roomId/timer-settings',
  members: '/rooms/:roomId/members',
  member: '/rooms/:roomId/members/:userId',
  membership: '/rooms/:roomId/membership',
  blocks: '/rooms/:roomId/blocks',
  block: '/rooms/:roomId/blocks/:userId',
  approveKnock: '/rooms/:roomId/knocks/:userId/approve',
  rejectKnock: '/rooms/:roomId/knocks/:userId/reject',
} as const;

export type RoomPathTemplate = Exclude<
  (typeof roomPaths)[keyof typeof roomPaths],
  '/rooms' | '/rooms/by-code/:code'
>;

/** Builds a concrete room URL path from one of the `roomPaths` templates. */
export const roomPath = (
  template: RoomPathTemplate,
  params: { readonly roomId: RoomId; readonly userId?: UserId },
): string =>
  template
    .replace(':roomId', encodeURIComponent(params.roomId))
    .replace(':userId', encodeURIComponent(params.userId ?? ''));

export const roomByCodePath = (code: string): string =>
  roomPaths.byCode.replace(':code', encodeURIComponent(code));
