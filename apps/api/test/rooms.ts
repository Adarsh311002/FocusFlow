import type { Server } from 'node:http';

import { API_BASE_PATH, errorBodySchema } from '@focus-flow/contracts';
import express from 'express';
import type { Logger } from 'pino';
import { vi } from 'vitest';

import { requireAuth } from '../src/modules/auth/middleware.js';
import { createRoomsRouter } from '../src/modules/rooms/http.js';
import type { RoomLive } from '../src/modules/rooms/ports.js';
import type { RoomsDeps } from '../src/modules/rooms/service.js';
import { createErrorHandler } from '../src/platform/http/errors.js';
import type { TestHarness } from './harness.js';
import type { TestUser } from './users.js';

/** A `RoomLive` that records every call and can be told to fail or to answer. */
export type FakeLive = RoomLive & {
  readonly calls: { name: string; args: unknown[] }[];
  readonly pendingKnocks: Set<string>;
  failPresentCounts: boolean;
  failKnockState: boolean;
  failAnnouncements: boolean;
  /** Makes only `resolveKnock` reject (the check still works). */
  failResolveKnock: boolean;
  /** Runs after `isKnockPending` read its answer and before it returns (a race gate). */
  afterIsKnockPending: ((roomId: string, userId: string) => Promise<void>) | undefined;
  /** Runs at the start of `announceMemberJoined` (a race gate). */
  onAnnounceMemberJoined: (() => Promise<void>) | undefined;
  /** Runs at the start of `resolveKnock`, after the membership is committed (a race gate). */
  beforeResolveKnock: ((roomId: string, userId: string) => Promise<void>) | undefined;
  counts: Map<string, number>;
  /** Names of the calls made, in order. */
  names: () => string[];
};

export const createFakeLive = (): FakeLive => {
  const calls: { name: string; args: unknown[] }[] = [];
  const fake: FakeLive = {
    calls,
    pendingKnocks: new Set<string>(),
    failPresentCounts: false,
    failKnockState: false,
    failAnnouncements: false,
    failResolveKnock: false,
    afterIsKnockPending: undefined,
    onAnnounceMemberJoined: undefined,
    beforeResolveKnock: undefined,
    counts: new Map<string, number>(),
    names: () => calls.map((call) => call.name),
    presentCounts: (roomIds) => {
      calls.push({ name: 'presentCounts', args: [roomIds] });
      if (fake.failPresentCounts) {
        return Promise.reject(new Error('redis down'));
      }
      return Promise.resolve(new Map(roomIds.map((id) => [id, fake.counts.get(id) ?? 0])));
    },
    isKnockPending: async (roomId, userId) => {
      calls.push({ name: 'isKnockPending', args: [roomId, userId] });
      if (fake.failKnockState) {
        throw new Error('redis down');
      }
      const pending = fake.pendingKnocks.has(`${roomId}:${userId}`);
      await fake.afterIsKnockPending?.(roomId, userId);
      return pending;
    },
    resolveKnock: async (roomId, hostId, userId, outcome) => {
      calls.push({ name: 'resolveKnock', args: [roomId, hostId, userId, outcome] });
      await fake.beforeResolveKnock?.(roomId, userId);
      if (fake.failKnockState || fake.failResolveKnock) {
        throw new Error('redis down');
      }
      // Like the real store: exactly one caller removes the knock.
      return fake.pendingKnocks.delete(`${roomId}:${userId}`);
    },
    announceMemberJoined: async (roomId, member) => {
      calls.push({ name: 'announceMemberJoined', args: [roomId, member] });
      await fake.onAnnounceMemberJoined?.();
      if (fake.failAnnouncements) {
        throw new Error('emit failed');
      }
    },
    announceMemberRemoved: (roomId, userId, reason) => {
      calls.push({ name: 'announceMemberRemoved', args: [roomId, userId, reason] });
      return fake.failAnnouncements ? Promise.reject(new Error('emit failed')) : Promise.resolve();
    },
    announceSettingsUpdated: (roomId, timerSettings) => {
      calls.push({ name: 'announceSettingsUpdated', args: [roomId, timerSettings] });
      return fake.failAnnouncements ? Promise.reject(new Error('emit failed')) : Promise.resolve();
    },
  };
  return fake;
};

export const createStubLogger = () => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { logger: logger as unknown as Logger, spies: logger };
};

export type RoomsTestApp = {
  readonly baseUrl: string;
  readonly live: FakeLive;
  readonly spies: ReturnType<typeof createStubLogger>['spies'];
  readonly close: () => Promise<void>;
};

/**
 * The rooms router on its own Express app over the harness database and auth, with a fake
 * `RoomLive`, so tests can observe and fail the live side without Redis tricks.
 */
export const startRoomsApp = async (
  harness: TestHarness,
  options: Pick<RoomsDeps, 'generateCode' | 'focus'> = {},
): Promise<RoomsTestApp> => {
  const live = createFakeLive();
  const { logger, spies } = createStubLogger();
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(
    API_BASE_PATH,
    createRoomsRouter({
      db: harness.db,
      live,
      logger,
      authenticate: requireAuth(harness.authDeps),
      ...options,
    }),
  );
  app.use(createErrorHandler(logger));
  const server: Server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => {
      resolve(started);
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the rooms test app did not listen');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    live,
    spies,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
};

export type ApiResult = { status: number; body: unknown };

/** One request against `baseUrl` + the API base path, as `user` (or anonymous). */
export const callApi = async (
  baseUrl: string,
  user: TestUser | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> => {
  const headers: Record<string, string> = {};
  if (user !== null) {
    headers.Authorization = `Bearer ${user.accessToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

export const errorCodeOf = (result: ApiResult): string =>
  errorBodySchema.parse(result.body).error.code;
