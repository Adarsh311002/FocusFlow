import type { Logger } from 'pino';

import { redisTimeMs } from '../../platform/redis.js';
import type { RoomTimerScheduler } from '../room-timer/jobs.js';
import type { RoomTimerService, RoomTimerStore } from '../room-timer/types.js';

// Reconciler step 2 (RT12; docs/architecture/focus-timing-protocol.md, "Reconciler"):
//   (a) running timers past their `endsAtMs` get their phase end now (the job was lost,
//       or Redis lost it and the timer outlived it);
//   (b) every running timer gets its phase-end job ensured (E20), which recreates a missing
//       one; a pending job costs one read.
// The service re-reads and re-evaluates under its own version check, so overlapping runs
// and racing jobs are harmless. One room's failure is logged and counted, never fatal.

export const ROOM_TIMER_SWEEP_BATCH = 100;

export type RoomTimerSweepSummary = {
  /** Phase ends the sweep performed. */
  readonly advanced: number;
  /** Rooms that were due but already handled, or not due after all. */
  readonly skipped: number;
  /** Jobs the sweep (re)created because they were missing. */
  readonly jobsRepaired: number;
  readonly failed: number;
};

export type RoomTimerSweepDeps = {
  readonly store: RoomTimerStore;
  readonly service: Pick<RoomTimerService, 'completePhase'>;
  readonly scheduler: RoomTimerScheduler;
  readonly redis: Parameters<typeof redisTimeMs>[0];
  readonly logger: Logger;
  readonly batchSize?: number;
};

export const sweepRoomTimers = async (
  deps: RoomTimerSweepDeps,
  shouldContinue: () => boolean = () => true,
): Promise<RoomTimerSweepSummary> => {
  const { store, service, scheduler, redis, logger, batchSize = ROOM_TIMER_SWEEP_BATCH } = deps;
  let advanced = 0;
  let skipped = 0;
  let jobsRepaired = 0;
  let failed = 0;

  // Takes a room whose state is not a running timer out of the running index, so stale
  // members cannot occupy the first due slots. The store removes it only when the hash is
  // absent or not running; a failure is logged and the next run tries again.
  const forget = async (roomId: string): Promise<void> => {
    try {
      await store.forget(roomId);
    } catch (error) {
      logger.warn({ err: error, roomId }, 'Could not clear a stale room timer index entry');
    }
  };

  // (a) Due timers. A room that stays due after being handled (not advanced, or failed) is
  // not tried again in this run, so the loop always ends. Handled rooms that stay in the
  // index are counted into the page size, so they never hide the ones behind them.
  const seen = new Set<string>();
  while (shouldContinue()) {
    const due = (await store.due(await redisTimeMs(redis), batchSize + seen.size)).filter(
      (roomId) => !seen.has(roomId),
    );
    if (due.length === 0) {
      break;
    }
    for (const roomId of due) {
      if (!shouldContinue()) {
        break;
      }
      seen.add(roomId);
      try {
        const { state } = await store.read(roomId);
        if (state === undefined || state.status !== 'running') {
          skipped += 1;
          await forget(roomId);
          continue;
        }
        const outcome = await service.completePhase(roomId, state.version);
        if (outcome.result === 'advanced') {
          advanced += 1;
        } else {
          skipped += 1;
          if (outcome.result === 'noop') {
            await forget(roomId);
          }
        }
      } catch (error) {
        failed += 1;
        logger.warn({ err: error, roomId }, 'Could not run the room timer phase end');
        // A malformed hash makes the read throw: clear it if it is not a running timer.
        await forget(roomId);
      }
    }
  }

  // (b) Running timers: the phase-end job must exist.
  for (let offset = 0; shouldContinue(); offset += batchSize) {
    const page = await store.running(offset, batchSize);
    for (const { roomId, endsAtMs } of page) {
      if (!shouldContinue()) {
        break;
      }
      try {
        const { state, nowMs } = await store.read(roomId);
        if (state === undefined || state.status !== 'running') {
          await forget(roomId);
          continue;
        }
        const outcome = await scheduler.ensurePhaseEnd(roomId, state.version, endsAtMs, nowMs);
        if (outcome !== 'pending') {
          jobsRepaired += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn({ err: error, roomId }, 'Could not ensure the room timer phase-end job');
      }
    }
    if (page.length < batchSize) {
      break;
    }
  }

  return { advanced, skipped, jobsRepaired, failed };
};
