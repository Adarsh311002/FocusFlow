import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { rooms } from '../../db/schema.js';
import type { TimerSettings } from './types.js';

// A room's saved phase durations, read from PostgreSQL whenever a phase is created (RT8:
// no Redis copy). The row stores seconds; the timer works in milliseconds.

export type ReadTimerSettings = (roomId: string) => Promise<TimerSettings | undefined>;

export const createTimerSettingsReader =
  (db: Db): ReadTimerSettings =>
  async (roomId) => {
    const [row] = await db
      .select({
        focusSeconds: rooms.focusSeconds,
        shortBreakSeconds: rooms.shortBreakSeconds,
        longBreakSeconds: rooms.longBreakSeconds,
      })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    return row === undefined
      ? undefined
      : {
          focusMs: row.focusSeconds * 1000,
          shortBreakMs: row.shortBreakSeconds * 1000,
          longBreakMs: row.longBreakSeconds * 1000,
        };
  };
