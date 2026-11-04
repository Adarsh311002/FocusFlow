import { roomIdSchema } from '@focus-flow/contracts';
import type { Logger } from 'pino';

import type { SocketEmitter } from '../../platform/socket.js';
import { roomRoom } from '../realtime/types.js';
import type { RoomTimerScheduler } from '../room-timer/jobs.js';
import { timerMachine } from '../room-timer/machine.js';
import type { RoomTimerService, TimerChange, TimerMachine } from '../room-timer/types.js';

// What follows every committed timer change (RT13), in this order: ensure the phase-end job
// when the new state is running, then tell the room. The change is already written, so a
// failure here is logged and never reported to the caller: a missing job is repaired by the
// reconciler (RT12), a missed event by the client's resync on reconnect. Scheduling comes
// first so that a client that saw `running` normally can rely on a job existing, but it is
// bounded: a scheduler that hangs (Redis stalled) delays the event and the command's
// acknowledgement by at most SCHEDULE_TIMEOUT_MS, then the event goes out regardless.

/** The longest the emit waits for the phase-end job to be ensured. */
export const SCHEDULE_TIMEOUT_MS = 2_000;

export type TimerFollowUpDeps = {
  readonly scheduler: RoomTimerScheduler;
  readonly emitter: SocketEmitter;
  readonly logger: Logger;
  readonly machine?: TimerMachine;
  readonly scheduleTimeoutMs?: number;
};

export const attachTimerFollowUps = (
  service: Pick<RoomTimerService, 'onChange'>,
  {
    scheduler,
    emitter,
    logger,
    machine = timerMachine,
    scheduleTimeoutMs = SCHEDULE_TIMEOUT_MS,
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
  });
};
