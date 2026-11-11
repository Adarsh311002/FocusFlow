import type { FocusSessionView } from '@focus-flow/contracts';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';
import { vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { timerMachine } from '../room-timer/machine.js';
import type { TimerState } from '../room-timer/types.js';
import { createRoomFocusService, type RoomFocusServiceImpl } from './service.js';
import type {
  AddParticipantResult,
  LedgerParticipant,
  MarkDisconnectedResult,
  RoomFocusChange,
  RoomGraceScheduler,
  RunLedger,
  RunRecord,
} from './types.js';

// In-memory ports for the room focus service tests: a controllable clock and timer, a ledger
// with the semantics of the Redis one (types.ts) and recorders for the scheduler and the
// announcements. The PostgreSQL side is always real.

export type GraceCall = {
  roomId: string;
  focusRunId: string;
  userId: string;
  disconnectedAtMs: number;
  delayMs: number;
};

export type Kit = {
  readonly service: RoomFocusServiceImpl;
  readonly clock: { nowMs: number };
  readonly changes: RoomFocusChange[];
  readonly graceCalls: GraceCall[];
  readonly present: Set<string>;
  readonly failures: { addParticipant: number; ledgerRead: number; timerGet: number };
  /** Runs once, right before the next `addParticipant` (a race gate). */
  readonly beforeAdd: { run: (() => void) | undefined };
  /** Runs once, right after the next successful `addParticipant` (a race gate). */
  readonly afterAdd: { run: (() => Promise<void>) | undefined };
  readonly timers: Map<string, TimerState>;
  readonly runs: Map<string, RunRecord>;
  readonly participants: Map<string, Map<string, LedgerParticipant>>;
  readonly ledger: RunLedger;
  readonly sessionViews: () => FocusSessionView[];
  /** Creates a running focus timer for the room with a fresh open run. */
  readonly startFocus: (
    roomId: string,
    options?: { durationMs?: number; elapsedMs?: number; status?: 'idle' | 'running' | 'paused' },
  ) => string;
  /** Closes the room's current run like a timer change would (and switches the phase). */
  readonly closeRun: (
    roomId: string,
    reason: 'reset' | 'phase_changed' | 'completed',
    options?: { elapsedAtCloseMs?: number; closedAtMs?: number },
  ) => string;
  readonly setPresent: (roomId: string, userId: string, present: boolean) => void;
  readonly elapsedOf: (roomId: string) => number;
  readonly participantsOf: (roomId: string, runId: string) => LedgerParticipant[];
};

export const createKit = (db: Db): Kit => {
  const clock = { nowMs: 1_000_000 };
  const timers = new Map<string, TimerState>();
  const runs = new Map<string, RunRecord>();
  const participants = new Map<string, Map<string, LedgerParticipant>>();
  const present = new Set<string>();
  const changes: RoomFocusChange[] = [];
  const graceCalls: GraceCall[] = [];
  const failures = { addParticipant: 0, ledgerRead: 0, timerGet: 0 };
  const beforeAdd: { run: (() => void) | undefined } = { run: undefined };
  const afterAdd: { run: (() => Promise<void>) | undefined } = { run: undefined };
  const key = (roomId: string, runId: string) => `${roomId}:${runId}`;
  // The fake ledger's participant-list versions (G2), bumped like the Redis scripts do.
  const versions = new Map<string, number>();
  const bump = (roomId: string, runId: string) => {
    versions.set(key(roomId, runId), (versions.get(key(roomId, runId)) ?? 0) + 1);
  };
  const entries = (roomId: string, runId: string) => participants.get(key(roomId, runId));

  const ledger: RunLedger = {
    read: (roomId, runId) => {
      if (failures.ledgerRead > 0) {
        failures.ledgerRead -= 1;
        return Promise.reject(new Error('redis down'));
      }
      return Promise.resolve({
        run: runs.get(key(roomId, runId)),
        participants: [...(entries(roomId, runId)?.values() ?? [])],
        participantsVersion: versions.get(key(roomId, runId)) ?? 0,
        nowMs: clock.nowMs,
      });
    },
    addParticipant: (roomId, runId, participant): Promise<AddParticipantResult> => {
      const gate = beforeAdd.run;
      beforeAdd.run = undefined;
      gate?.();
      if (failures.addParticipant > 0) {
        failures.addParticipant -= 1;
        return Promise.reject(new Error('redis down'));
      }
      const timer = timers.get(roomId);
      const run = runs.get(key(roomId, runId));
      if (timer?.phase !== 'focus' || timer.focusRunId !== runId || run?.status !== 'open') {
        return Promise.resolve({ result: 'run_changed' });
      }
      const map = participants.get(key(roomId, runId)) ?? new Map<string, LedgerParticipant>();
      participants.set(key(roomId, runId), map);
      const existing = map.get(participant.userId);
      if (existing !== undefined) {
        return Promise.resolve({ result: 'exists', participant: existing });
      }
      map.set(participant.userId, participant);
      bump(roomId, runId);
      const after = afterAdd.run;
      afterAdd.run = undefined;
      return (after?.() ?? Promise.resolve()).then(() => ({ result: 'added' }) as const);
    },
    removeParticipant: (roomId, runId, userId, sessionId) => {
      const map = entries(roomId, runId);
      if (map?.get(userId)?.sessionId !== sessionId) {
        return Promise.resolve(false);
      }
      bump(roomId, runId);
      return Promise.resolve(map.delete(userId));
    },
    markDisconnected: (roomId, runId, userId, disconnect): Promise<MarkDisconnectedResult> => {
      const p = entries(roomId, runId)?.get(userId);
      if (p === undefined) return Promise.resolve('not_participant');
      if (runs.get(key(roomId, runId))?.status !== 'open') return Promise.resolve('run_closed');
      if (p.disconnectedAtMs !== null) return Promise.resolve('already_disconnected');
      if (timers.get(roomId)?.version !== disconnect.timerVersion) {
        return Promise.resolve('conflict');
      }
      entries(roomId, runId)?.set(userId, {
        ...p,
        disconnectedAtMs: disconnect.disconnectedAtMs,
        elapsedAtDisconnectMs: disconnect.elapsedAtDisconnectMs,
      });
      bump(roomId, runId);
      return Promise.resolve('marked');
    },
    clearDisconnected: (roomId, runId, userId, expected) => {
      const p = entries(roomId, runId)?.get(userId);
      if (p === undefined || p.disconnectedAtMs !== expected) return Promise.resolve(false);
      entries(roomId, runId)?.set(userId, {
        ...p,
        disconnectedAtMs: null,
        elapsedAtDisconnectMs: null,
      });
      bump(roomId, runId);
      return Promise.resolve(true);
    },
    unsettled: () =>
      Promise.resolve(
        [...runs.values()]
          .filter((run) => run.status === 'closed')
          .map((run) => ({ roomId: run.roomId, runId: run.runId })),
      ),
    finishRun: (roomId, runId) => {
      const run = runs.get(key(roomId, runId));
      if (run?.status !== 'closed' || (entries(roomId, runId)?.size ?? 0) > 0) {
        return Promise.resolve(false);
      }
      runs.delete(key(roomId, runId));
      participants.delete(key(roomId, runId));
      versions.delete(key(roomId, runId));
      return Promise.resolve(true);
    },
  };

  const grace: RoomGraceScheduler = {
    ensureGrace: (job, delayMs) => {
      graceCalls.push({ ...job, delayMs });
      return Promise.resolve();
    },
  };

  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  const service = createRoomFocusService({
    db,
    timer: {
      get: (roomId) => {
        if (failures.timerGet > 0) {
          failures.timerGet -= 1;
          return Promise.reject(new Error('redis down'));
        }
        const state = timers.get(roomId);
        return Promise.resolve(state === undefined ? undefined : { state, nowMs: clock.nowMs });
      },
    },
    ledger,
    grace,
    isPresent: (roomId, userId) => Promise.resolve(present.has(`${roomId}:${userId}`)),
    logger,
  });
  service.onChange((change) => {
    changes.push(change);
  });

  const elapsedOf = (roomId: string): number => {
    const state = timers.get(roomId);
    if (state === undefined) throw new Error('no timer');
    return timerMachine.elapsedMs(state, clock.nowMs);
  };

  return {
    service,
    clock,
    changes,
    graceCalls,
    present,
    failures,
    beforeAdd,
    afterAdd,
    timers,
    runs,
    participants,
    ledger,
    sessionViews: () =>
      changes.flatMap((change) => (change.kind === 'session' ? [change.session] : [])),
    startFocus: (roomId, options = {}) => {
      const runId = uuidv7();
      const durationMs = options.durationMs ?? 1_500_000;
      const status = options.status ?? 'running';
      timers.set(roomId, {
        phase: 'focus',
        status,
        durationMs,
        elapsedBeforeMs: options.elapsedMs ?? 0,
        segmentStartedAtMs: status === 'running' ? clock.nowMs : null,
        version: 1,
        focusRunId: runId,
      });
      runs.set(key(roomId, runId), {
        roomId,
        runId,
        status: 'open',
        closeReason: null,
        openedAtMs: clock.nowMs,
        closedAtMs: null,
        elapsedAtCloseMs: null,
      });
      return runId;
    },
    closeRun: (roomId, reason, options = {}) => {
      const state = timers.get(roomId);
      const runId = state?.focusRunId;
      if (state === undefined || runId === null || runId === undefined) {
        throw new Error('no run to close');
      }
      const elapsedAtCloseMs =
        options.elapsedAtCloseMs ??
        (reason === 'completed' ? state.durationMs : timerMachine.elapsedMs(state, clock.nowMs));
      runs.set(key(roomId, runId), {
        roomId,
        runId,
        status: 'closed',
        closeReason: reason,
        openedAtMs: runs.get(key(roomId, runId))?.openedAtMs ?? clock.nowMs,
        closedAtMs: options.closedAtMs ?? clock.nowMs,
        elapsedAtCloseMs,
      });
      timers.set(roomId, {
        ...state,
        phase: 'short_break',
        status: 'idle',
        focusRunId: null,
        version: state.version + 1,
        segmentStartedAtMs: null,
        elapsedBeforeMs: 0,
      });
      return runId;
    },
    setPresent: (roomId, userId, isPresent) => {
      const id = `${roomId}:${userId}`;
      if (isPresent) present.add(id);
      else present.delete(id);
    },
    elapsedOf,
    participantsOf: (roomId, runId) => [...(entries(roomId, runId)?.values() ?? [])],
  };
};
