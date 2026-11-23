import { roomIdSchema } from '@focus-flow/contracts';
import type { Logger } from 'pino';

import type { SocketEmitter } from '../../platform/socket.js';
import { roomRoom } from '../realtime/types.js';
import type { RoomFocusService } from '../room-focus/types.js';
import type { RoomTimerScheduler } from '../room-timer/jobs.js';
import { timerMachine } from '../room-timer/machine.js';
import type { RoomTimerService, TimerChange, TimerMachine } from '../room-timer/types.js';
import { announceParticipants } from './focus-announcers.js';

// What follows every committed timer change (RT13), in this order: ensure the phase-end job
// when the new state is running, then tell the room. The change is already written, so a
// failure here is logged and never reported to the caller: a missing job is repaired by the
// reconciler (RT12), a missed event by the client's resync on reconnect. Scheduling comes
// first so that a client that saw `running` normally can rely on a job existing, but it is
// bounded: a scheduler that hangs (Redis stalled) delays the event and the command's
// acknowledgement by at most SCHEDULE_TIMEOUT_MS, then the event goes out regardless.

/** The longest the emit waits for the phase-end job to be ensured. */
export const SCHEDULE_TIMEOUT_MS = 2_000;

/**
 * Phase 8: a change that closed or opened a focus run also (a) tells the room the participant
 * list of the run that is now current (a new run starts empty) and (b) settles the closed run
 * (RF3, RF9): every participant's session ends in PostgreSQL, the service announces each
 * `focus:session:updated`. Both come after the timer event, run detached and in parallel (the command acknowledgement
 * does not wait for them) and are bounded like scheduling:
 * the closed run stays in the unsettled set, so a settlement that fails or times out is
 * finished by the reconciler (step 3).
 */
export type TimerFollowUpDeps = {
  readonly scheduler: RoomTimerScheduler;
  readonly emitter: SocketEmitter;
  readonly logger: Logger;
  readonly machine?: TimerMachine;
  readonly scheduleTimeoutMs?: number;
  /** Room focus runs (Phase 8); without it run effects are not followed up. */
  readonly focus?: Pick<RoomFocusService, 'participants' | 'settleRun'>;
};

/** Races `work` against a timeout; rejects on either failure and never leaves a timer behind. */
const bounded = async (work: Promise<unknown>, timeoutMs: number): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`took longer than ${String(timeoutMs)} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

export const attachTimerFollowUps = (
  service: Pick<RoomTimerService, 'onChange'>,
  {
    scheduler,
    emitter,
    logger,
    machine = timerMachine,
    scheduleTimeoutMs = SCHEDULE_TIMEOUT_MS,
    focus,
  }: TimerFollowUpDeps,
): void => {
  service.onChange(async (change: TimerChange) => {
    const { roomId, state, nowMs } = change;
    const endsAtMs = machine.endsAtMs(state);
    if (state.status === 'running' && endsAtMs !== null) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          scheduler.ensurePhaseEnd(roomId, state.version, endsAtMs, nowMs),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`scheduling took longer than ${String(scheduleTimeoutMs)} ms`));
            }, scheduleTimeoutMs);
          }),
        ]);
      } catch (error) {
        logger.warn(
          { err: error, roomId, version: state.version },
          'Could not schedule the room timer phase end; the reconciler repairs it',
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    try {
      emitter.to(roomRoom(roomId)).emit('room:timer:state', {
        roomId: roomIdSchema.parse(roomId),
        timer: machine.toView(roomId, state),
        serverNowMs: nowMs,
      });
    } catch (error) {
      logger.warn({ err: error, roomId, version: state.version }, 'Could not emit the room timer');
    }

    const { runs } = change;
    if (focus === undefined || runs === undefined) {
      return;
    }
    // Detached and in parallel (Rev I L6, J10): the host's command acknowledgement waits for
    // the timer event, not for the participant list or the settlement of the closed run. Both
    // are bounded and their failures logged; the reconciler finishes an unsettled run.
    const effects: Promise<void>[] = [];
    if (runs.close !== undefined || runs.open !== undefined) {
      effects.push(
        bounded(announceParticipants(focus, emitter, logger, roomId), scheduleTimeoutMs).catch(
          (error: unknown) => {
            logger.warn({ err: error, roomId }, 'Could not announce the new focus run');
          },
        ),
      );
    }
    if (runs.close !== undefined) {
      const { runId } = runs.close;
      effects.push(
        bounded(focus.settleRun(roomId, runId), scheduleTimeoutMs).catch((error: unknown) => {
          logger.warn(
            { err: error, roomId, runId },
            'Could not settle the closed focus run; the reconciler finishes it',
          );
        }),
      );
    }
    void Promise.all(effects);
  });
};
