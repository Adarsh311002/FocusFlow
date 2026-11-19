import type { UpdateMeRequest } from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import type { UserRow } from '../auth/queries.js';

/** Applies the user's own settings (A2); `undefined` fields are left as they are. */
export const updateOwnSettings = async (
  db: Db,
  userId: string,
  input: UpdateMeRequest,
): Promise<UserRow | undefined> => {
  const [row] = await db
    .update(users)
    .set({
      ...(input.dailyGoalSeconds === undefined ? {} : { dailyGoalSeconds: input.dailyGoalSeconds }),
    })
    .where(eq(users.id, userId))
    .returning();
  return row;
};
