import {
  ROOM_GRACE_JOB,
  type RoomGraceJob,
  roomGraceJobId,
  roomGraceJobSchema,
} from '@focus-flow/contracts';

import { type EnsurableQueue, ensureJob, type FocusSessionJob } from '../focus-sessions/jobs.js';
import type { JobOutcome } from '../focus-sessions/lifecycle.js';
import type { RoomFocusService, RoomGraceScheduler } from './types.js';

// The room participant grace job (RF7, docs/architecture/focus-timing-protocol.md,
// "Scheduled jobs"). It lives on the `focus-session` queue next to the solo jobs, with the
// same ensure semantics (E20). The id is derived from the participant and the disconnect
// (`roomGraceJobId`), so scheduling the same disconnect twice is one job and a reconnect
// followed by a new disconnect is another. The delay is only a wake-up hint: the job never
// trusts its payload, it asks the service, which re-reads the ledger and the room's
// presence and settles only a disconnect that still holds exactly `disconnectedAtMs`.

/** The queue operations the scheduler needs (a fake in unit tests). */
export type RoomGraceQueue = EnsurableQueue & {
  readonly add: (
    name: string,
    data: Extract<FocusSessionJob, RoomGraceJob>,
    options: { jobId: string; delay: number },
  ) => Promise<unknown>;
};

export const createRoomGraceScheduler = (queue: RoomGraceQueue): RoomGraceScheduler => ({
  ensureGrace: async (job, delayMs) => {
    const payload = roomGraceJobSchema.parse({ schemaVersion: 1, ...job });
    const jobId = roomGraceJobId(payload);
    await ensureJob(queue, jobId, () =>
      queue.add(ROOM_GRACE_JOB, payload, { jobId, delay: Math.max(0, Math.ceil(delayMs)) }),
    );
  },
});

/**
 * The processor the `focus-session` worker dispatches `room-grace` jobs to. The service's
 * answer is mapped onto the worker's shared outcome vocabulary (logging only):
 * `abandoned` -> grace_expired, `completed` -> completed, `reconnected` -> continued,
 * `stale` -> the disconnect is no longer the participant's current one.
 */
export const createRoomGraceProcessor =
  (service: Pick<RoomFocusService, 'graceExpired'>) =>
  async (job: RoomGraceJob): Promise<JobOutcome> => {
    const result = await service.graceExpired(
      job.roomId,
      job.focusRunId,
      job.userId,
      job.disconnectedAtMs,
    );
    switch (result) {
      case 'abandoned':
        return { kind: 'settled', transition: 'grace_expired' };
      case 'completed':
        return { kind: 'settled', transition: 'completed' };
      case 'reconnected':
        return { kind: 'continued' };
      case 'stale':
        return { kind: 'no_op', reason: 'marker_changed' };
    }
  };
